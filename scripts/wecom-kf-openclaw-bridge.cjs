#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const rootDir = process.cwd();
const stateDir = path.join(os.homedir(), ".openclaw-wecom-kf");
const statePath = path.join(stateDir, "state.json");
const logPath = path.join(stateDir, "bridge.log");
const port = Number(process.env.WECOM_KF_BRIDGE_PORT || 19088);
const callbackPath = process.env.WECOM_KF_CALLBACK_PATH || "/wecom-kf";
const agentId = process.env.OPENCLAW_JOBTEST_AGENT_ID || "job-agent";
const intakeDelayMs = 500;

const config = {
  corpId: need("WECOM_KF_CORP_ID"),
  secret: need("WECOM_KF_SECRET"),
  token: need("WECOM_KF_CALLBACK_TOKEN"),
  encodingAESKey: need("WECOM_KF_ENCODING_AES_KEY"),
  openKfid: process.env.WECOM_KF_OPEN_KFID || "",
};

fs.mkdirSync(stateDir, { recursive: true });
const state = loadState();
let accessTokenCache = null;
let processing = Promise.resolve();

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((err) => {
    log(`[wecom-kf] request failed: ${err.message || err}`);
    if (!res.headersSent) res.writeHead(500);
    res.end("error");
  });
});

server.listen(port, "127.0.0.1", () => {
  log(`[wecom-kf] listening on http://127.0.0.1:${port}${callbackPath}`);
  log(`[wecom-kf] log file: ${logPath}`);
});

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

  if (requestUrl.pathname !== callbackPath) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  if (req.method === "GET") {
    verifyUrl(requestUrl, res);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("method not allowed");
    return;
  }

  const body = await readBody(req);
  const encrypted = xmlValue(body, "Encrypt");
  const signature = requestUrl.searchParams.get("msg_signature") || "";
  const timestamp = requestUrl.searchParams.get("timestamp") || "";
  const nonce = requestUrl.searchParams.get("nonce") || "";

  if (!checkSignature(signature, timestamp, nonce, encrypted)) {
    res.writeHead(401);
    res.end("bad signature");
    return;
  }

  const plainXml = decrypt(encrypted);
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("success");

  processing = processing
    .then(() => processCallback(plainXml))
    .catch((err) => log(`[wecom-kf] async failed: ${err.message || err}`));
}

function verifyUrl(requestUrl, res) {
  const echostr = requestUrl.searchParams.get("echostr") || "";
  const signature = requestUrl.searchParams.get("msg_signature") || "";
  const timestamp = requestUrl.searchParams.get("timestamp") || "";
  const nonce = requestUrl.searchParams.get("nonce") || "";

  if (!checkSignature(signature, timestamp, nonce, echostr)) {
    res.writeHead(401);
    res.end("bad signature");
    return;
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(decrypt(echostr));
}

async function processCallback(xml) {
  const event = xmlValue(xml, "Event");
  const token = xmlValue(xml, "Token") || xmlValue(xml, "token");
  const openKfid =
    xmlValue(xml, "OpenKfId") ||
    xmlValue(xml, "OpenKFID") ||
    xmlValue(xml, "open_kfid") ||
    config.openKfid;

  log(`[wecom-kf] callback event=${event || "unknown"} open_kfid=${openKfid || "unknown"}`);

  if (!token) {
    log("[wecom-kf] callback has no Token; ignored");
    return;
  }

  await sleep(intakeDelayMs);

  const result = await syncMessages({ token, openKfid });
  const messages = Array.isArray(result.msg_list) ? result.msg_list : [];
  log(`[wecom-kf] sync_msg got ${messages.length} message(s)`);

  const pending = messages
    .map(normalizeMessage)
    .filter(Boolean)
    .filter((m) => !state.processedMsgIds.includes(m.msgId));

  const batches = new Map();
  for (const item of pending) {
    const key = `${item.openKfid}\n${item.externalUserId}`;
    const batch = batches.get(key) || {
      openKfid: item.openKfid,
      externalUserId: item.externalUserId,
      items: [],
    };
    batch.items.push(item);
    batches.set(key, batch);
  }

  for (const batch of batches.values()) {
    await processBatch(batch);
  }

  saveState();
}

function normalizeMessage(message) {
  const msgId = String(message.msgid || "");
  const msgtype = String(message.msgtype || "");
  const origin = Number(message.origin);
  const text =
    message.text && typeof message.text.content === "string" ? message.text.content.trim() : "";
  const externalUserId = String(message.external_userid || "");
  const openKfid = String(message.open_kfid || config.openKfid || "");

  if (!msgId) return null;

  if (msgtype !== "text" || !text || !externalUserId || !openKfid) {
    remember(msgId);
    return null;
  }

  if (!(origin === 3 || origin === 4 || Number.isNaN(origin))) {
    remember(msgId);
    return null;
  }

  return { msgId, text, externalUserId, openKfid };
}

async function processBatch(batch) {
  const ids = batch.items.map((i) => i.msgId);
  const text =
    batch.items.length === 1
      ? batch.items[0].text
      : [
          "候选人连续发来了多条消息，请合并理解后一次性回复：",
          "",
          ...batch.items.map((i, n) => `${n + 1}. ${i.text}`),
        ].join("\n");

  log(`[wecom-kf] candidate batch ${batch.externalUserId}: ${batch.items.length} message(s)`);

  let reply = "";
  try {
    reply = await runOpenClaw({ externalUserId: batch.externalUserId, text });
  } catch (err) {
    ids.forEach(remember);
    log(`[wecom-kf] OpenClaw failed: ${err.message || err}`);
    return;
  }

  if (!reply || /^NO_REPLY$/i.test(reply)) {
    ids.forEach(remember);
    return;
  }

  try {
    await sendText({ openKfid: batch.openKfid, externalUserId: batch.externalUserId, text: reply });
    log(`[wecom-kf] replied to ${batch.externalUserId}`);
  } catch (err) {
    log(`[wecom-kf] send failed: ${err.message || err}`);
  }

  ids.forEach(remember);
}

async function runOpenClaw({ externalUserId, text }) {
  const safeExternalUserId = safeId(externalUserId);
  const historyPath = path.join(stateDir, `history-${safeExternalUserId}.json`);

  let history = [];
  try {
    const loaded = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    if (Array.isArray(loaded)) history = loaded;
  } catch {
    history = [];
  }

  const recentHistory = history
    .slice(-30)
    .map((item) => `${item.role}：${item.text}`)
    .join("\n");

  const messagePath = path.join(
    stateDir,
    `message-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const prompt = [
    "来自微信客服候选人的新消息。",
    `候选人ID：${externalUserId}`,
    "",
    "最近对话记录：",
    recentHistory || "暂无",
    "",
    "本次新消息：",
    text,
    "",
    "回复要求：",
    "1. 先根据最近对话判断已知信息，不要重复询问已经知道的姓名、岗位、是否方便沟通等内容。",
    "2. 按不同求职者分别积累信息，并基于已知信息继续追问。",
    "3. 每次只问一个核心问题，微信纯文本回复，不要使用 Markdown 样式符号。",
    "4. 收集到的信息不需要发给求职者汇总确认。",
    "5. 不要发送系统报错、日志、调试信息或内部失败原因。",
    "6. 只输出要发给候选人的正文；如果不需要回复，只输出 NO_REPLY。",
  ].join("\n");

  fs.writeFileSync(messagePath, prompt, "utf8");

  const sessionKey = `agent:${agentId}:wecom-kf-${safeExternalUserId}`;
  const args = [
    "scripts/run-node.mjs",
    "--dev",
    "agent",
    "--agent",
    agentId,
    "--local",
    "--session-key",
    sessionKey,
    "--message-file",
    messagePath,
    "--json",
    "--timeout",
    process.env.OPENCLAW_JOBTEST_TIMEOUT_SECONDS || "180",
  ];

  log(`[wecom-kf] running OpenClaw agent=${agentId} session=${sessionKey}`);

  let reply = "";
  try {
    const output = await execFile(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      timeout: Number(process.env.OPENCLAW_JOBTEST_TIMEOUT_MS || 240000),
    });

    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < start) {
      throw new Error(`OpenClaw returned non-JSON output: ${output.slice(0, 500)}`);
    }

    const result = JSON.parse(output.slice(start, end + 1));
    const payloadText = Array.isArray(result.payloads)
      ? result.payloads
          .map((payload) => (typeof payload.text === "string" ? payload.text : ""))
          .join("\n")
          .trim()
      : "";

    reply = (
      payloadText ||
      result.finalAssistantVisibleText ||
      result.finalAssistantRawText ||
      result.text ||
      ""
    ).trim();
  } finally {
    try {
      fs.unlinkSync(messagePath);
    } catch {}
  }

  history.push({ role: "候选人", text, at: new Date().toISOString() });

  if (reply && !/^NO_REPLY$/i.test(reply)) {
    history.push({ role: "HR", text: reply, at: new Date().toISOString() });
  }

  fs.writeFileSync(historyPath, JSON.stringify(history.slice(-60), null, 2), "utf8");

  if (!reply || /^NO_REPLY$/i.test(reply)) {
    return "";
  }

  return reply;
}

async function syncMessages({ token, openKfid }) {
  const accessToken = await getAccessToken();
  const payload = { token, limit: 1000, voice_format: 0 };
  if (openKfid) payload.open_kfid = openKfid;

  return wecomJson(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${encodeURIComponent(accessToken)}`,
    payload,
  );
}

async function sendText({ openKfid, externalUserId, text }) {
  const accessToken = await getAccessToken();

  return wecomJson(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`,
    {
      touser: externalUserId,
      open_kfid: openKfid,
      msgtype: "text",
      text: { content: text },
    },
  );
}

async function getAccessToken() {
  const now = Date.now();
  if (accessTokenCache && accessTokenCache.expiresAt > now + 60000) return accessTokenCache.token;

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`;
  const res = await fetch(url);
  const body = await res.json();

  if (body.errcode !== 0 || !body.access_token) {
    throw new Error(`gettoken failed: ${JSON.stringify(redact(body))}`);
  }

  accessTokenCache = {
    token: body.access_token,
    expiresAt: now + (Number(body.expires_in || 7200) - 300) * 1000,
  };

  return accessTokenCache.token;
}

async function wecomJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (body.errcode !== 0) throw new Error(`WeCom API failed: ${JSON.stringify(redact(body))}`);
  return body;
}

function checkSignature(signature, timestamp, nonce, encrypted) {
  const joined = [config.token, timestamp, nonce, encrypted].sort().join("");
  const hash = crypto.createHash("sha1").update(joined).digest("hex");
  return hash === signature;
}

function decrypt(encrypted) {
  const aesKey = Buffer.from(config.encodingAESKey + "=", "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);
  const plain = pkcs7Unpad(decrypted);
  const msgLength = plain.readUInt32BE(16);

  return plain.subarray(20, 20 + msgLength).toString("utf8");
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  return buf.subarray(0, buf.length - pad);
}

function xmlValue(xml, tag) {
  const match = new RegExp(
    `<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`,
    "i",
  ).exec(xml || "");
  return match ? decodeXml(match[1] || match[2] || "").trim() : "";
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function execFile(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      { ...options, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stdout}\n${stderr}`.trim()));
        resolve(stdout);
      },
    );
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

function remember(id) {
  state.processedMsgIds.push(String(id));
  state.processedMsgIds = Array.from(new Set(state.processedMsgIds)).slice(-1000);
}

function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      processedMsgIds: Array.isArray(loaded.processedMsgIds)
        ? loaded.processedMsgIds.map(String)
        : [],
    };
  } catch {
    return { processedMsgIds: [] };
  }
}

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function safeId(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;

  const copy = {};
  for (const [k, v] of Object.entries(value))
    copy[k] = /token|secret|key/i.test(k) ? "[redacted]" : redact(v);
  return copy;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(line) {
  console.log(line);
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
}
