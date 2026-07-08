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
const candidateAssessmentPath =
  process.env.WECOM_KF_CANDIDATE_ASSESSMENT_PATH ||
  path.join(stateDir, "candidate-assessments.json");
const projectPlanningTestPdfPath =
  process.env.WECOM_KF_PROJECT_PLANNING_TEST_PDF_PATH ||
  path.join(stateDir, "assets", "项目策划岗位试岗测试题.pdf");
const port = Number(process.env.WECOM_KF_BRIDGE_PORT || 19088);
const callbackPath = process.env.WECOM_KF_CALLBACK_PATH || "/wecom-kf";
const agentId = process.env.OPENCLAW_JOBTEST_AGENT_ID || "job-agent";
const intakeDelayMs = Number(process.env.WECOM_KF_INTAKE_DELAY_MS || 500);
const replyPartDelayMinMs = Number(
  process.env.WECOM_KF_REPLY_PART_DELAY_MIN_MS || process.env.WECOM_KF_REPLY_PART_DELAY_MS || 2000,
);
const replyPartDelayMaxMs = Number(
  process.env.WECOM_KF_REPLY_PART_DELAY_MAX_MS || process.env.WECOM_KF_REPLY_PART_DELAY_MS || 6000,
);
const preSendRecheckMax = Number(process.env.WECOM_KF_PRE_SEND_RECHECK_MAX || 3);
const openClawTimeoutMs = Number(process.env.OPENCLAW_JOBTEST_TIMEOUT_MS || 55000);
const replyJudgeEnabled = process.env.WECOM_KF_REPLY_JUDGE_MODE === "1";
const replyJudgeTimeoutMs = Number(process.env.WECOM_KF_REPLY_JUDGE_TIMEOUT_MS || 20000);
const fastMode = process.env.WECOM_KF_FAST_MODE !== "0";
const identityFollowupDelayMs = Number(process.env.WECOM_KF_IDENTITY_FOLLOWUP_DELAY_MS || 60000);
const asyncAssessmentMode = process.env.WECOM_KF_ASYNC_ASSESSMENT_MODE !== "0";
const asyncAssessmentTimeoutMs = Number(process.env.WECOM_KF_ASYNC_ASSESSMENT_TIMEOUT_MS || 90000);
const asyncAssessmentQuietMs = Number(process.env.WECOM_KF_ASYNC_ASSESSMENT_QUIET_MS || 5000);
const interviewCompleteMessage =
  process.env.WECOM_KF_INTERVIEW_COMPLETE_MESSAGE ||
  "感谢您的配合，后续我们会进行一个综合评估，如果进入复试，有消息会第一时间联系您。";
const jobGuidesDir =
  process.env.WECOM_KF_JOB_GUIDES_DIR || path.join(rootDir, "scripts", "wecom-kf-job-guides");
const globalPromptPath =
  process.env.WECOM_KF_GLOBAL_PROMPT_PATH || path.join(jobGuidesDir, "_global.md");
const jobOverviewPath =
  process.env.WECOM_KF_JOB_OVERVIEW_PATH || path.join(jobGuidesDir, "_job-overview.md");
const globalPrompt = loadPromptFile(globalPromptPath);
const jobOverview = loadPromptFile(jobOverviewPath);
const jobGuides = loadJobGuides(jobGuidesDir);

const config = {
  corpId: need("WECOM_KF_CORP_ID"),
  secret: need("WECOM_KF_SECRET"),
  token: need("WECOM_KF_CALLBACK_TOKEN"),
  encodingAESKey: need("WECOM_KF_ENCODING_AES_KEY"),
  openKfid: process.env.WECOM_KF_OPEN_KFID || "",
};

fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.dirname(candidateAssessmentPath), { recursive: true });
fs.mkdirSync(path.dirname(projectPlanningTestPdfPath), { recursive: true });
const state = loadState();
let accessTokenCache = null;
let processing = Promise.resolve();
let candidateAssessmentsBroken = false;
const asyncAssessmentQueues = new Map();
const candidateActivityAt = new Map();

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
  log(`[wecom-kf] candidate assessment file: ${candidateAssessmentPath}`);
  log(`[wecom-kf] project planning test PDF: ${projectPlanningTestPdfPath}`);
  log(`[wecom-kf] global prompt file: ${globalPromptPath}`);
  log(`[wecom-kf] job overview file: ${jobOverviewPath}`);
  log(`[wecom-kf] job guide dir: ${jobGuidesDir} (${jobGuides.length} guide(s))`);
  log(
    `[wecom-kf] intake delay: ${intakeDelayMs}ms; reply part delay: ${replyPartDelayMinMs}-${replyPartDelayMaxMs}ms; pre-send recheck max: ${preSendRecheckMax}; OpenClaw timeout: ${openClawTimeoutMs}ms; reply judge: ${replyJudgeEnabled ? "on" : "off"}; reply judge timeout: ${replyJudgeTimeoutMs}ms; fast mode: ${fastMode ? "on" : "off"}; identity followup delay: ${identityFollowupDelayMs}ms; async assessment: ${asyncAssessmentMode ? "on" : "off"}; async assessment timeout: ${asyncAssessmentTimeoutMs}ms; async assessment quiet: ${asyncAssessmentQuietMs}ms`,
  );
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

  const textKeys = new Set(
    pending
      .filter((item) => item.kind === "text")
      .map((item) => `${item.openKfid}\n${item.externalUserId}`),
  );
  for (const item of pending.filter((entry) => entry.kind === "enter")) {
    const key = `${item.openKfid}\n${item.externalUserId}`;
    if (!textKeys.has(key)) await processEnterSession(item);
  }

  const batches = new Map();
  for (const item of pending.filter((entry) => entry.kind === "text")) {
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
    await processBatch(batch, { token });
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

  if (msgtype === "event") {
    const eventType = String(
      message.event?.event_type ||
        message.event_type ||
        message.event?.event ||
        message.event ||
        "",
    );
    const eventExternalUserId = String(
      message.external_userid || message.event?.external_userid || "",
    );
    const eventOpenKfid = String(
      message.open_kfid || message.event?.open_kfid || config.openKfid || "",
    );
    if (isEnterSessionEvent(eventType) && eventExternalUserId && eventOpenKfid) {
      return {
        kind: "enter",
        msgId,
        externalUserId: eventExternalUserId,
        openKfid: eventOpenKfid,
      };
    }
    remember(msgId);
    return null;
  }

  if (msgtype !== "text" || !text || !externalUserId || !openKfid) {
    remember(msgId);
    return null;
  }

  if (!(origin === 3 || origin === 4 || Number.isNaN(origin))) {
    remember(msgId);
    return null;
  }

  return { kind: "text", msgId, text, externalUserId, openKfid };
}

function isEnterSessionEvent(eventType) {
  return /enter[_-]?session|user[_-]?enter|kf[_-]?user[_-]?enter/i.test(eventType);
}

async function processEnterSession(item) {
  if (!shouldFastSendGreeting(item.externalUserId)) {
    remember(item.msgId);
    return;
  }

  const reply = identityAndPositionQuestion();
  try {
    await sendText({
      openKfid: item.openKfid,
      externalUserId: item.externalUserId,
      text: reply,
    });
    saveHrConversation({
      externalUserId: item.externalUserId,
      reply,
    });
    log(`[wecom-kf] greeted new candidate ${item.externalUserId}`);
  } catch (err) {
    log(`[wecom-kf] greeting send failed: ${err.message || err}`);
  }
  remember(item.msgId);
}

async function processBatch(batch, { token }) {
  const items = [...batch.items];
  let text = buildBatchText(items);
  markCandidateActivity(batch.externalUserId);

  log(`[wecom-kf] candidate batch ${batch.externalUserId}: ${items.length} message(s)`);

  let agentResult = { reply: "", actions: {}, candidateUpdate: null };
  try {
    agentResult = await runInterviewTurn({ externalUserId: batch.externalUserId, text });

    for (let attempt = 0; attempt < preSendRecheckMax; attempt += 1) {
      let newerItems = [];
      try {
        newerItems = await fetchNewItemsBeforeSend({
          token,
          openKfid: batch.openKfid,
          externalUserId: batch.externalUserId,
          knownIds: new Set(items.map((item) => item.msgId)),
        });
      } catch (err) {
        log(`[wecom-kf] pre-send recheck failed; sending current reply: ${err.message || err}`);
        break;
      }

      if (newerItems.length === 0) break;

      items.push(...newerItems);
      text = buildBatchText(items, { beforeSendRegeneration: true });
      log(
        `[wecom-kf] found ${newerItems.length} newer message(s) before send; regenerating reply for ${batch.externalUserId}`,
      );
      agentResult = await runInterviewTurn({ externalUserId: batch.externalUserId, text });
    }
  } catch (err) {
    items.forEach((item) => remember(item.msgId));
    log(`[wecom-kf] OpenClaw failed: ${err.message || err}`);
    return;
  }

  const reply = await rewriteContradictoryPersonalFollowup({
    externalUserId: batch.externalUserId,
    reply: agentResult.reply || "",
    text,
  });
  const actions = agentResult.actions || {};
  let sentReply = false;
  let sentReplyParts = [];

  if (reply && !/^NO_REPLY$/i.test(reply)) {
    const outboundTexts = splitOutboundReply(reply, {
      reserveSlots: actions.sendProjectPlanningTestPdf ? 1 : 0,
    });
    try {
      for (let i = 0; i < outboundTexts.length; i += 1) {
        if (i > 0) {
          const delayMs = randomReplyPartDelayMs();
          log(`[wecom-kf] waiting ${delayMs}ms before reply part ${i + 1}`);
          await sleep(delayMs);
        }
        await sendText({
          openKfid: batch.openKfid,
          externalUserId: batch.externalUserId,
          text: outboundTexts[i],
        });
      }
      sentReply = true;
      sentReplyParts = outboundTexts;
      log(`[wecom-kf] replied to ${batch.externalUserId} (${outboundTexts.length} text part(s))`);
    } catch (err) {
      log(`[wecom-kf] send failed: ${err.message || err}`);
    }
  }

  if (actions.sendProjectPlanningTestPdf) {
    try {
      await sendProjectPlanningTestPdf({
        openKfid: batch.openKfid,
        externalUserId: batch.externalUserId,
      });
      log(`[wecom-kf] sent project planning test PDF to ${batch.externalUserId}`);
    } catch (err) {
      log(`[wecom-kf] project planning test PDF send failed: ${err.message || err}`);
    }
  }

  saveFinalConversationAndAssessment({
    externalUserId: batch.externalUserId,
    text,
    reply: sentReply ? reply : "",
    replyParts: sentReply ? sentReplyParts : [],
    candidateUpdate: agentResult.candidateUpdate,
  });
  if (actions.scheduleIdentityFollowup) {
    scheduleIdentityFollowup({
      openKfid: batch.openKfid,
      externalUserId: batch.externalUserId,
    });
  }
  enqueueCandidateAssessment({
    externalUserId: batch.externalUserId,
  });

  items.forEach((item) => remember(item.msgId));
}

function scheduleIdentityFollowup({ openKfid, externalUserId }) {
  setTimeout(() => {
    void sendIdentityFollowupIfNeeded({ openKfid, externalUserId }).catch((err) => {
      log(`[wecom-kf] identity followup send failed: ${err.message || err}`);
    });
  }, identityFollowupDelayMs);
}

async function sendIdentityFollowupIfNeeded({ openKfid, externalUserId }) {
  const safeExternalUserId = safeId(externalUserId);
  const history = loadCandidateHistory(safeExternalUserId);
  if (!hasAskedIdentityAndPosition(history) || hasSentOpeningIntro(history)) return;

  const candidateRecord = loadCandidateRecord(safeExternalUserId);
  const recentHistory = history
    .slice(-30)
    .map((item) => `${item.role}：${item.text}`)
    .join("\n");
  const matchedJobGuide = selectJobGuide({
    candidateRecord,
    recentHistory,
    text: "",
  });
  const status = getIdentityStatus({
    candidateRecord,
    history,
    text: "",
    matchedJobGuide,
  });
  if (status.complete) return;

  const reply = status.hasName
    ? "应聘哪个岗位？"
    : status.hasPosition
      ? "请问怎么称呼？"
      : identityAndPositionQuestion();
  if (hasHrAskedExact(history, reply)) return;

  await sendText({ openKfid, externalUserId, text: reply });
  saveHrConversation({ externalUserId, reply });
  log(`[wecom-kf] sent identity followup to ${externalUserId}`);
}

function hasHrAskedExact(history, reply) {
  const normalizedReply = normalizeQuestionText(reply);
  return history.some(
    (item) => item.role === "HR" && normalizeQuestionText(item.text) === normalizedReply,
  );
}

async function runInterviewTurn({ externalUserId, text }) {
  const strictGuideResult = await buildStrictGuideInterviewTurn({ externalUserId, text, fastMode });
  if (strictGuideResult) return strictGuideResult;
  return runOpenClaw({ externalUserId, text });
}

async function buildStrictGuideInterviewTurn({ externalUserId, text, fastMode }) {
  const safeExternalUserId = safeId(externalUserId);
  const history = loadCandidateHistory(safeExternalUserId);
  const candidateRecord = loadCandidateRecord(safeExternalUserId);
  const recentHistory = history
    .slice(-30)
    .map((item) => `${item.role}：${item.text}`)
    .join("\n");
  const matchedJobGuide = selectJobGuide({
    candidateRecord,
    recentHistory,
    text,
  });
  const identityStatus = getIdentityStatus({ candidateRecord, history, text, matchedJobGuide });
  if (!matchedJobGuide) {
    if (shouldFastAskIdentityAndPosition({ candidateRecord, history, text })) {
      log("[wecom-kf] strict guide interview asking identity and position");
      return {
        reply: identityAndPositionQuestion(),
        actions: {},
        candidateUpdate: { stage: "初始沟通" },
      };
    }
    if (shouldWaitForIdentityFollowup({ candidateRecord, history, text, identityStatus })) {
      log("[wecom-kf] strict guide interview waiting before identity followup");
      return {
        reply: "NO_REPLY",
        actions: { scheduleIdentityFollowup: true },
        candidateUpdate: { stage: "初始沟通" },
      };
    }
    return null;
  }

  const historyText = [recentHistory, text].filter(Boolean).join("\n");
  const askedGuideQuestions = getAskedGuideQuestions(candidateRecord, matchedJobGuide.fileName);
  const fastQuestionCount = askedGuideQuestions.length;

  const question = pickNextGuideQuestion(matchedJobGuide.content, historyText, askedGuideQuestions);
  if (!question) {
    if (hasCompletedGuide(candidateRecord, matchedJobGuide.fileName)) {
      return { reply: "NO_REPLY", actions: {}, candidateUpdate: null };
    }
    log(`[wecom-kf] strict guide interview completed for ${matchedJobGuide.fileName}`);
    return {
      reply: interviewCompleteMessage,
      actions: {},
      candidateUpdate: buildGuideCompleteCandidateUpdate({ matchedJobGuide }),
    };
  }

  if (!hasSentOpeningIntro(history) && !identityStatus.complete) {
    log("[wecom-kf] strict guide interview waiting before identity followup");
    return {
      reply: "NO_REPLY",
      actions: { scheduleIdentityFollowup: true },
      candidateUpdate: buildFastCandidateUpdate({ matchedJobGuide, askedQuestion: null }),
    };
  }

  if (!hasSentOpeningIntro(history)) {
    log(
      `[wecom-kf] strict guide interview sending opening intro and first ${matchedJobGuide.fileName} question`,
    );
    return {
      reply: `好的\n\n${openingIntroMessage()}\n\n${question}`,
      actions: {},
      candidateUpdate: buildFastCandidateUpdate({ matchedJobGuide, askedQuestion: question }),
    };
  }

  if (fastMode) {
    log(
      `[wecom-kf] fast mode strict guide question from ${matchedJobGuide.fileName} (${fastQuestionCount + 1})`,
    );
    return {
      reply: question,
      actions: {},
      candidateUpdate: buildFastCandidateUpdate({ matchedJobGuide, askedQuestion: question }),
    };
  }

  log("[wecom-kf] fast mode off; using OpenClaw normal interview mode");
  return null;
}

function buildFastCandidateUpdate({ matchedJobGuide, askedQuestion }) {
  const update = {
    position: positionFromGuideFile(matchedJobGuide.fileName),
    stage: "初筛中",
  };
  if (askedQuestion) {
    update.asked_guide_questions = {
      [matchedJobGuide.fileName]: [askedQuestion],
    };
  }
  return update;
}

function buildGuideCompleteCandidateUpdate({ matchedJobGuide }) {
  return {
    position: positionFromGuideFile(matchedJobGuide.fileName),
    stage: "初筛已完成",
    guide_completed: {
      [matchedJobGuide.fileName]: true,
    },
  };
}

function hasCompletedGuide(candidateRecord, guideFileName) {
  return Boolean(candidateRecord?.guide_completed?.[guideFileName]);
}

function positionFromGuideFile(fileName) {
  if (fileName === "sales.md") return "销售岗";
  if (fileName === "project-planning.md") return "项目策划岗";
  return fileName.replace(/\.md$/iu, "");
}

function shouldFastAskIdentityAndPosition({ candidateRecord, history, text }) {
  if (candidateRecord?.position || candidateRecord?.role) return false;
  if (history.some((item) => item.role === "HR")) return false;
  const normalized = normalizeQuestionText(text);
  if (!normalized) return true;
  if (/应聘|岗位|销售|策划|商务|运营|客服|开发|设计|产品/u.test(text)) return false;
  return /^(你好|您好|在吗|hi|hello|哈喽|嗨)$/iu.test(normalized) || normalized.length <= 12;
}

function shouldWaitForIdentityFollowup({ candidateRecord, history, text, identityStatus }) {
  if (!hasAskedIdentityAndPosition(history)) return false;
  if (hasSentOpeningIntro(history)) return false;
  if (identityStatus.complete) return false;
  if (candidateRecord?.position || candidateRecord?.role) return false;
  if (!normalizeQuestionText(text)) return false;
  return true;
}

function getIdentityStatus({ candidateRecord, history, text, matchedJobGuide }) {
  const hasPosition = Boolean(
    matchedJobGuide ||
    candidateRecord?.position ||
    candidateRecord?.role ||
    findJobGuideInCandidateText(text) ||
    history.some((item) => item.role !== "HR" && findJobGuideInCandidateText(item.text)),
  );
  const hasName = Boolean(
    candidateRecord?.name ||
    hasLikelyCandidateNameInText(text, matchedJobGuide) ||
    hasLikelyCandidateNameInIdentityReplies(history, matchedJobGuide),
  );
  return {
    complete: hasName && hasPosition,
    hasName,
    hasPosition,
  };
}

function findJobGuideInCandidateText(text) {
  const normalizedText = normalizeQuestionText(text);
  if (!normalizedText) return null;
  return jobGuides.find((guide) =>
    guide.aliases.some((alias) => {
      const normalizedAlias = normalizeQuestionText(alias);
      return normalizedAlias && normalizedText.includes(normalizedAlias);
    }),
  );
}

function countHrMessages(history) {
  return history.filter((item) => item.role === "HR").length;
}

function openingQuestion() {
  return identityAndPositionQuestion();
}

function identityAndPositionQuestion() {
  return extractPromptSection(globalPrompt, "首次进线消息") || "请问怎么称呼？应聘哪个岗位？";
}

function openingIntroMessage() {
  return (
    extractPromptSection(globalPrompt, "初面说明") ||
    "您好，本次为微信线上初面，接下来我会依次向您提问，麻烦您结合自身真实情况如实作答即可，合适直接推老板（部门直属领导）复试，面试题目约有10-20左右，可能需要花费您10分钟时间耐心解答~[玫瑰]"
  );
}

function shouldFastSendGreeting(externalUserId) {
  const safeExternalUserId = safeId(externalUserId);
  const history = loadCandidateHistory(safeExternalUserId);
  if (history.some((item) => item.role === "HR")) return false;
  const candidateRecord = loadCandidateRecord(safeExternalUserId);
  return !(candidateRecord?.position || candidateRecord?.role);
}

function hasAskedIdentityAndPosition(history) {
  return history.some((item) => item.role === "HR" && isIdentityQuestionText(item.text));
}

function hasLikelyCandidateNameInText(text, matchedJobGuide) {
  const value = String(text || "").trim();
  if (!value) return false;
  let normalized = normalizeQuestionText(value);
  const guideForText = matchedJobGuide || findJobGuideInCandidateText(text);
  const matchedAliases = guideForText?.aliases || [];
  for (const alias of matchedAliases) {
    normalized = normalized.replaceAll(normalizeQuestionText(alias), "");
  }
  normalized = normalized.replace(
    /我叫|我是|本人|应聘|岗位|职位|求职|面试|销售岗|销售|项目策划岗|项目策划|策划岗|策划|岗|的/g,
    "",
  );
  if (!normalized || /^(你好|您好|在吗|hi|hello)$/iu.test(normalized)) return false;
  if (/^[\d零一二三四五六七八九十百千万年月天岁]+$/u.test(normalized)) return false;
  if (
    /(公司|资源|团队|实力|个人原因|离职|行业|互联网|销售|岗位|薪资|期望|已婚|未婚|小孩|孩子|老家|哪里|地铁|黄村|广东|广州|深圳|北京|上海)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  return /^[\p{Script=Han}A-Za-z·]{2,8}$/u.test(normalized);
}

function hasLikelyCandidateNameInIdentityReplies(history, matchedJobGuide) {
  const identityQuestionIndex = findFirstOpenIdentityQuestionIndex(history);
  if (identityQuestionIndex < 0) return false;
  return history
    .slice(identityQuestionIndex + 1)
    .some((item) => item.role !== "HR" && hasLikelyCandidateNameInText(item.text, matchedJobGuide));
}

function findFirstOpenIdentityQuestionIndex(history) {
  const lastIntroIndex = findLastOpeningIntroIndex(history);
  for (let index = lastIntroIndex + 1; index < history.length; index += 1) {
    const item = history[index];
    if (item.role !== "HR") continue;
    if (isIdentityQuestionText(item.text)) return index;
  }
  return -1;
}

function findLastOpeningIntroIndex(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role !== "HR") continue;
    if (normalizeQuestionText(item.text).includes(normalizeQuestionText(openingIntroMessage()))) {
      return index;
    }
  }
  return -1;
}

function isIdentityQuestionText(text) {
  const normalizedText = normalizeQuestionText(text);
  return (
    normalizedText.includes(normalizeQuestionText(identityAndPositionQuestion())) ||
    normalizedText.includes("怎么称呼") ||
    (normalizedText.includes("应聘") &&
      (normalizedText.includes("岗位") || normalizedText.includes("职位")))
  );
}

function findLastHrQuestion(history) {
  return (
    [...history]
      .reverse()
      .find((item) => item.role === "HR" && looksLikeQuestionForCandidate(item.text))?.text || ""
  );
}

function looksLikeQuestionForCandidate(text) {
  const value = String(text || "").trim();
  if (!value || value === "好的") return false;
  if (normalizeQuestionText(value).includes(normalizeQuestionText(openingIntroMessage())))
    return false;
  return (
    /[？?]/u.test(value) ||
    /(说下|介绍|了解|方便|是否|有没有|哪里|多少|多久|什么|怎么|哪)/u.test(value)
  );
}

async function judgeCandidateAnswerSufficiency({
  recentHistory,
  currentQuestion,
  candidateMessage,
  nextQuestion,
  matchedJobGuide,
}) {
  if (!currentQuestion || !candidateMessage) return { action: "answered", reply: "", reason: "" };

  const messagePath = path.join(
    stateDir,
    `answer-judge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const prompt = [
    "你是企业微信招聘面试的回答充分性判断器。",
    "你只判断候选人对 current_question 的回答是否足够，以及是否需要追问。",
    "必须只输出合法 JSON，不要 Markdown，不要额外文字。",
    "",
    "判断原则：",
    "1. 如果候选人的回答已经能满足问题的核心信息，action=answered，即使回答很短也可以。例如问居住地/地铁站，回答“黄村”可视为已回答，不要为了确认区域还是地铁站继续追问。",
    "2. 如果 current_question 是复合问题，只追问缺失且重要的部分。例如问已婚未婚、有没有小孩，候选人只回答“已婚”，需要追问有没有小孩。",
    "3. 如果候选人明确拒绝或表示问题无关，通常 action=answered，除非该信息对岗位流程非常关键。",
    "4. followup 只能问一个核心问题，不要总结、不要说记下了、不要复述候选人回答。",
    "5. 如果回答答非所问且需要候选人补充，action=followup。",
    "",
    "JSON 输出格式：",
    JSON.stringify(
      {
        action: "answered | followup | wait",
        reply: "action=followup 时填写要发给候选人的追问，否则空字符串",
        reason: "简短说明，内部日志用，不发给候选人",
      },
      null,
      2,
    ),
    "",
    "recent_history:",
    recentHistory || "暂无",
    "",
    "current_question:",
    currentQuestion,
    "",
    "candidate_message:",
    candidateMessage,
    "",
    "next_question_if_answered:",
    nextQuestion || "",
    "",
    "Additional hard rules:",
    "- A question can be followed up at most once. If recent_history shows HR already asked a follow-up for current_question and the candidate then replied, action=answered unless another explicit sub-question from current_question is still unanswered.",
    '- If candidate_message is semantically responsive to current_question, even if it is short like "personal reason", action=answered. Do not invent new follow-up dimensions from the answer.',
    "- Only follow up for an explicit missing part of current_question. Do not ask about tenure, duration, family details, salary, location, or other extra details unless current_question itself asked for them.",
    "- If action=answered, the caller will send next_question_if_answered. Do not put summaries or acknowledgements in reply.",
    "",
    "matched_job_file:",
    matchedJobGuide ? `${matchedJobGuide.fileName}\n${matchedJobGuide.content}` : "未匹配",
  ].join("\n");

  fs.writeFileSync(messagePath, prompt, "utf8");

  const args = [
    "scripts/run-node.mjs",
    "--dev",
    "agent",
    "--agent",
    agentId,
    "--local",
    "--session-key",
    `agent:${agentId}:wecom-kf-answer-judge`,
    "--message-file",
    messagePath,
    "--json",
    "--timeout",
    String(Math.ceil(replyJudgeTimeoutMs / 1000)),
  ];

  try {
    const output = await execFile(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      timeout: replyJudgeTimeoutMs,
    });
    return normalizeAnswerJudgeDecision(extractAgentJsonText(output));
  } catch (err) {
    log(`[wecom-kf] answer judge failed; continuing to next question: ${err.message || err}`);
    return { action: "answered", reply: "", reason: "judge failed" };
  } finally {
    try {
      fs.unlinkSync(messagePath);
    } catch {}
  }
}

function normalizeAnswerJudgeDecision(rawText) {
  const parsed =
    tryParseJsonObject(stripMarkdownJsonFence(rawText)) ||
    tryParseJsonObject(extractJsonObject(rawText)) ||
    {};
  const action = String(parsed.action || "").toLowerCase();
  if (action === "followup") {
    const reply = String(parsed.reply || "").trim();
    return reply
      ? { action: "followup", reply, reason: String(parsed.reason || "") }
      : { action: "answered", reply: "", reason: String(parsed.reason || "") };
  }
  if (action === "wait") return { action: "wait", reply: "", reason: String(parsed.reason || "") };
  return { action: "answered", reply: "", reason: String(parsed.reason || "") };
}

async function runOpenClaw({ externalUserId, text }) {
  const safeExternalUserId = safeId(externalUserId);
  const candidateRecord = loadCandidateRecord(safeExternalUserId);
  const history = loadCandidateHistory(safeExternalUserId);

  const recentHistory = history
    .slice(-30)
    .map((item) => `${item.role}：${item.text}`)
    .join("\n");
  const matchedJobGuide = selectJobGuide({
    candidateRecord,
    recentHistory,
    text,
  });

  const messagePath = path.join(
    stateDir,
    `message-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const prompt = buildReplyPrompt({
    candidateRecord,
    matchedJobGuide,
    recentHistory,
    text,
  });

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
    process.env.OPENCLAW_JOBTEST_TIMEOUT_SECONDS || String(Math.ceil(openClawTimeoutMs / 1000)),
  ];

  log(`[wecom-kf] running OpenClaw agent=${agentId} session=${sessionKey}`);

  let reply = "";
  let candidateUpdate = null;
  let actions = {};
  try {
    let output = "";
    try {
      output = await execFile(process.execPath, args, {
        cwd: rootDir,
        env: process.env,
        timeout: openClawTimeoutMs,
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        const fallbackReply = buildFastFallbackReply({
          candidateRecord,
          matchedJobGuide,
          recentHistory,
          text,
        });
        log(
          `[wecom-kf] OpenClaw timed out after ${openClawTimeoutMs}ms; using fast fallback reply`,
        );
        return {
          reply: fallbackReply,
          actions: {},
          candidateUpdate:
            matchedJobGuide && fallbackReply
              ? buildFastCandidateUpdate({
                  matchedJobGuide,
                  askedQuestion: fallbackReply,
                })
              : null,
        };
      }
      throw err;
    }

    const parsed = parseAgentJsonReply(extractAgentJsonText(output));
    reply = parsed.reply;
    candidateUpdate = parsed.candidateUpdate;
    actions = parsed.actions;
  } finally {
    try {
      fs.unlinkSync(messagePath);
    } catch {}
  }

  if (!reply || /^NO_REPLY$/i.test(reply)) {
    return { reply: "", actions, candidateUpdate };
  }

  return { reply, actions, candidateUpdate };
}

function buildReplyPrompt({ candidateRecord, matchedJobGuide, recentHistory, text }) {
  return [
    "你是企业微信招聘客服 bridge 的内部响应生成器。",
    "必须只输出一个合法 JSON 对象，不要使用 Markdown 代码块，不要输出 JSON 以外的文字。",
    "本轮只负责生成要发给求职者的微信回复，不要整理资料、不要评分、不要输出 candidate_update。",
    "reply 字段只能放候选人可见的微信正文，不得包含 JSON、candidate_update、assessment、score、评分、加分、减分、总分、等级等内部字段或明细。",
    "",
    "JSON 输出格式：",
    JSON.stringify(
      {
        reply: "要发给候选人的微信正文；如果不需要回复，填 NO_REPLY",
        actions: {
          send_project_planning_test_pdf:
            "是否发送项目策划测试题 PDF，布尔值。只有项目策划候选人完成基础信息收集、准备正式发题时才填 true",
        },
      },
      null,
      2,
    ),
    "",
    "全局提示词：",
    globalPrompt || "未配置全局提示词。",
    "",
    "当前所有岗位概述：",
    jobOverview || "未配置岗位概述文档。",
    "",
    "已积累候选人资料评分：",
    JSON.stringify(candidateRecord || {}, null, 2),
    "",
    "最近对话记录：",
    recentHistory || "暂无",
    "",
    "回复要求：",
    "1. 先根据最近对话判断已知信息，不要重复询问已经知道的姓名、岗位、是否方便沟通等内容。",
    "1.1 生成 reply 前必须先做回复自检：对照最近一条 HR 问题和候选人最新回复，判断候选人是否已经回答核心信息；如果已回答，不要重复追问同一问题，直接进入岗位文件里的下一个问题。",
    "1.2 如果上一题是复合问题，候选人只回答了其中一部分，只追问缺失且必要的一个核心点；例如问已婚未婚、有没有小孩，候选人只答“已婚”，才追问有没有小孩。",
    "1.3 如果问题是居住地、区域、附近地铁站，候选人回答“黄村”“白云”“天河客运站”等地点短语，应视为已回答，不要为了确认是区域还是地铁站继续追问。",
    "1.4 如果候选人已经表示没有小孩、问题与岗位无关或不愿回答家庭隐私，不要继续追问小孩几个、多大、谁带、配偶在哪等家庭问题，直接进入下一个岗位题。",
    "1.5 同一个问题最多追问一次；如果 HR 已经围绕上一题追问过，候选人随后给了回答，就直接进入岗位文件里的下一题，除非上一题原文里还有另一个明确子问题完全未回答。",
    "1.6 候选人只要对当前问题有语义上的回答，即使很短，例如离职原因回答“个人原因”，也视为已回答；不要基于这个回答自行扩展新追问，例如不要追问之前几份工作每份做多久，除非当前问题原文本来就问了工作时长。",
    "1.7 追问只能补当前问题原文里缺失的必要部分，不能临时新增岗位文档或上一题都没有问的维度。",
    "1.8 岗位文件原题如果已经用同义表达问过并且候选人答过，就视为已覆盖，不要再用原题重复问。例如“做过哪些行业/卖什么产品服务”已覆盖“呆过什么行业/主营业务产品”；“客户偏什么端/大C小C大B小B占比”已覆盖“客户构成及各类客户业绩占比”。",
    "1.9 进入下一道岗位题时，必须复制具体岗位文档“题目：”里的原题原文，只去掉开头序号，不要润色、改写、同义替换、拆分或合并题目。比如原题是“4.客户资源如何来的？自拓还是公司给的资源？ 如果是自拓？自拓的渠道或者方法是？目前客户资源是在自己手上还是公司？ 月拜访客户跟成交客户分别是多少？”时，直接问去掉“4.”后的完整原题。",
    "2. 按不同求职者分别积累信息，并基于已知信息继续追问。",
    "2.1 候选人可能把姓名、岗位、当前状态拆成连续几条短消息发送；如果本次新消息、最近对话或已积累资料里已经出现姓名或岗位，不要再重复问。",
    "3. 每次只问一个核心问题，微信纯文本回复，不要使用 Markdown 样式符号。",
    "3.1 岗位题不要拆成多条微信消息；一道岗位原题即使包含多个问号，也作为一条消息整体发送。",
    "3.2 不要写“他/她”“他（她）”“她/他”这种不自然的不确定式称呼；需要泛指负责人或面试官时，用“他”或直接写“负责人”。",
    "4. 收集到的信息不需要发给求职者汇总确认。",
    "4.1 不要总结、复述或确认候选人刚回答的内容；不要写“记下了”“收到”“了解了”“清楚了”“这块清楚了”“好的，已记录”“我这边记录一下”等承接语。",
    "4.2 候选人回答有效且不需要追问时，直接进入岗位文件里的下一个问题。",
    "4.3 只有候选人回答含糊、缺关键数字或明显答非所问时，才围绕当前问题追问；追问也不要先总结。",
    "5. 不要发送系统报错、日志、调试信息或内部失败原因。",
    "6. 候选人资料、评分、加减分明细是内部信息，绝不能写进 reply。本轮不要输出 candidate_update，后台会单独整理评分。",
    "7. 只决定当前应该如何回复求职者；资料沉淀、评分、总结交给后台任务处理。",
    "8. 如果需要发送项目策划测试题 PDF，只能通过 actions.send_project_planning_test_pdf=true 触发；reply 里不要写服务器文件路径或内部动作名。",
    "",
    "具体岗位文档：",
    matchedJobGuide
      ? `已匹配岗位文件：${matchedJobGuide.fileName}\n${matchedJobGuide.content}`
      : `未匹配到具体岗位文档。请先根据岗位概述和以下别名判断岗位；如果仍不明确，追问应聘岗位。当前可匹配岗位别名：${
          jobGuides.flatMap((guide) => guide.aliases).join("、") || "无"
        }。`,
    "",
    "本次新消息：",
    text,
  ].join("\n");
}

function extractAgentJsonText(output) {
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

  return (
    payloadText ||
    result.finalAssistantVisibleText ||
    result.finalAssistantRawText ||
    result.text ||
    ""
  ).trim();
}

function enqueueCandidateAssessment({ externalUserId }) {
  if (!asyncAssessmentMode) return;
  const safeExternalUserId = safeId(externalUserId);
  const previous = asyncAssessmentQueues.get(safeExternalUserId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => runCandidateAssessment({ externalUserId, safeExternalUserId }))
    .catch((err) => {
      log(`[wecom-kf] async candidate assessment failed: ${err.message || err}`);
    })
    .finally(() => {
      if (asyncAssessmentQueues.get(safeExternalUserId) === next) {
        asyncAssessmentQueues.delete(safeExternalUserId);
      }
    });
  asyncAssessmentQueues.set(safeExternalUserId, next);
}

function markCandidateActivity(externalUserId) {
  candidateActivityAt.set(safeId(externalUserId), Date.now());
}

async function waitForCandidateQuiet(safeExternalUserId) {
  while (true) {
    const lastActivityAt = candidateActivityAt.get(safeExternalUserId) || 0;
    const remaining = asyncAssessmentQuietMs - (Date.now() - lastActivityAt);
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, asyncAssessmentQuietMs));
  }
}

async function runCandidateAssessment({ externalUserId, safeExternalUserId }) {
  if (candidateAssessmentsBroken) return;
  await waitForCandidateQuiet(safeExternalUserId);
  const candidateRecord = loadCandidateRecord(safeExternalUserId);
  const history = loadCandidateHistory(safeExternalUserId);
  if (history.length === 0) return;

  const recentHistory = history
    .slice(-40)
    .map((item) => `${item.role}：${item.text}`)
    .join("\n");
  const matchedJobGuide = selectJobGuide({
    candidateRecord,
    recentHistory,
    text: "",
  });
  const latestCandidateMessage =
    [...history].reverse().find((item) => item.role !== "HR")?.text || "";
  const latestReply = [...history].reverse().find((item) => item.role === "HR")?.text || "";
  const messagePath = path.join(
    stateDir,
    `assessment-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const prompt = buildAssessmentPrompt({
    candidateRecord,
    matchedJobGuide,
    recentHistory,
  });

  fs.writeFileSync(messagePath, prompt, "utf8");

  const sessionKey = `agent:${agentId}:wecom-kf-assessment-${safeExternalUserId}`;
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
    process.env.WECOM_KF_ASYNC_ASSESSMENT_TIMEOUT_SECONDS ||
      String(Math.ceil(asyncAssessmentTimeoutMs / 1000)),
  ];

  log(`[wecom-kf] running async assessment agent=${agentId} session=${sessionKey}`);

  const assessmentStartedAt = Date.now();
  try {
    const output = await execFile(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      timeout: asyncAssessmentTimeoutMs,
    });
    if ((candidateActivityAt.get(safeExternalUserId) || 0) > assessmentStartedAt) {
      log(
        `[wecom-kf] async assessment deferred for ${externalUserId}; newer candidate message arrived while assessment was running`,
      );
      return;
    }
    const candidateUpdate = normalizeCandidateUpdateQuestions({
      candidateUpdate: parseCandidateUpdateReply(extractAgentJsonText(output)),
      matchedJobGuide,
      recentHistory,
    });
    if (!candidateUpdate) {
      log("[wecom-kf] async assessment returned no candidate_update");
      return;
    }
    saveCandidateRecord({
      safeExternalUserId,
      externalUserId,
      update: candidateUpdate,
      lastCandidateMessage: latestCandidateMessage,
      lastReply: latestReply,
    });
  } finally {
    try {
      fs.unlinkSync(messagePath);
    } catch {}
  }
}

function buildAssessmentPrompt({ candidateRecord, matchedJobGuide, recentHistory }) {
  return [
    "你是企业微信招聘面试记录的后台资料整理与评分器。",
    "必须只输出一个合法 JSON 对象，不要使用 Markdown 代码块，不要输出 JSON 以外的文字。",
    "本任务在微信回复已经发出后异步执行，不要生成要发给求职者的话，只更新内部 candidate_update。",
    "",
    "JSON 输出格式：",
    JSON.stringify(
      {
        candidate_update: buildCandidateUpdateTemplate(),
      },
      null,
      2,
    ),
    "",
    "全局提示词：",
    globalPrompt || "未配置全局提示词。",
    "",
    "当前所有岗位概述：",
    jobOverview || "未配置岗位概述文档。",
    "",
    "已积累候选人资料评分：",
    JSON.stringify(candidateRecord || {}, null, 2),
    "",
    "最近对话记录：",
    recentHistory || "暂无",
    "",
    "整理要求：",
    "1. 只根据已知对话和已积累资料更新 candidate_update，不要编造信息。",
    "2. 不知道的字段填 null 或空数组；已有资料中明确的信息不要因为本轮未提到而清空。",
    "3. 根据候选人应聘岗位和岗位评分标准持续更新评分、加减分和内部简评。",
    "4. 如果岗位文件中的某个问题已经由通用开场问题覆盖，例如哪里人、住哪里、最近薪资、期望薪资，就直接基于回答评分，不要认为缺失。",
    "5. candidate_questions 只记录候选人主动问过、需要面试官解答的问题。",
    "6. next_missing_info 只能放具体岗位文档“题目：”中的原始问题原文；不要放字段名、概括版问题、润色后的客服话术或自行扩展的问题。",
    "7. 如果岗位原题发送时需要拆成多条或改得更口语，由微信回复任务处理；candidate_update 里必须保留岗位文档原题。",
    "",
    "具体岗位文档：",
    matchedJobGuide
      ? `已匹配岗位文件：${matchedJobGuide.fileName}\n${matchedJobGuide.content}`
      : `未匹配到具体岗位文档。请先根据岗位概述和以下别名判断岗位；如果对话中岗位已明确，请写入 candidate_update.position。当前可匹配岗位别名：${
          jobGuides.flatMap((guide) => guide.aliases).join("、") || "无"
        }。`,
  ].join("\n");
}

function buildCandidateUpdateTemplate() {
  return {
    name: "候选人姓名，未知填 null",
    position: "应聘岗位，未知填 null",
    stage: "当前流程阶段，例如 初始沟通/销售初筛/测试题已发/待负责人确认",
    known_info: {
      work_status: "在职/离职/未知",
      education: "学历专业，未知填 null",
      years_experience: "工作年限，未知填 null",
      hometown: "老家，未知填 null",
      residence: "当前居住地或附近地铁站，未知填 null",
      age: "年龄，未知填 null",
      marital_child_status: "婚育、小孩情况、照看安排，未知填 null",
      spouse_work: "配偶所在地和工作行业，未知填 null",
      arrival_time: "最快到岗时间，未知填 null",
      project_planning_experience: "项目策划相关经历，未知填 null",
      representative_project: "代表项目或策划案例，未知填 null",
      planning_outputs: "方案、活动、商业计划、项目书等输出物经验，未知填 null",
      tools: "常用工具，未知填 null",
      collaboration: "跨部门沟通、客户沟通或执行协调经验，未知填 null",
      sales_performance: "销售业绩，未知填 null",
      customer_type: "客户类型，未知填 null",
      decision_level: "对接层级，未知填 null",
      sales_cycle: "成交周期，未知填 null",
      acquisition_channels: "获客方式，未知填 null",
      sales_industry_product: "销售过的行业、产品和业务类型，未知填 null",
      customer_mix: "客户结构占比，例如大B/小B/C端/G端，未知填 null",
      customer_resource_source: "客户资源来源，自拓/公司分配/转介绍/其他渠道，未知填 null",
      visit_and_close_count: "月拜访客户数、月成交客户数，未知填 null",
      tender_experience: "招投标经验、项目规模、是否独立负责全流程投标，未知填 null",
      order_value_payment_cycle: "客单价、回款周期、月任务和完成率，未知填 null",
      annual_sales_by_company: "近两家公司年度销售业绩，未知填 null",
      key_customers: "服务过的重点客户或代表客户，未知填 null",
      team_management: "带团队人数、团队人均业绩和管理经验，未知填 null",
      salary_structure: "底薪、薪资结构和考核标准，未知填 null",
      commission_structure: "提成点数、阶梯和平均月提成，未知填 null",
      salary_expectation: "薪资期望或薪酬结构，未知填 null",
    },
    candidate_questions: ["候选人问过、需要面试官解答的问题"],
    next_missing_info: ["具体岗位文档“题目：”中的原始问题原文；不要改写、概括或自创"],
    assessment: {
      score: "0-100 的数字；信息不足时也要基于已知信息给暂定分",
      level: "信息不足/需谨慎/基本匹配/较匹配/优秀",
      plus: [{ item: "加分项", points: 0, evidence: "依据" }],
      minus: [{ item: "减分项", points: 0, evidence: "依据" }],
      summary: "给招聘负责人看的内部简评，不要写给候选人",
    },
  };
}

function parseCandidateUpdateReply(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  const normalized = stripMarkdownJsonFence(raw);
  const parsed =
    tryParseJsonObject(normalized) || tryParseJsonObject(extractJsonObject(normalized));
  if (!parsed) return null;
  const candidateUpdate =
    parsed.candidate_update ||
    parsed.candidateUpdate ||
    parsed.candidate_record ||
    parsed.candidateRecord ||
    null;
  return candidateUpdate && typeof candidateUpdate === "object" && !Array.isArray(candidateUpdate)
    ? candidateUpdate
    : null;
}

function normalizeCandidateUpdateQuestions({ candidateUpdate, matchedJobGuide, recentHistory }) {
  if (!candidateUpdate || typeof candidateUpdate !== "object" || Array.isArray(candidateUpdate)) {
    return candidateUpdate;
  }

  const next = { ...candidateUpdate };
  if (matchedJobGuide?.content) {
    next.next_missing_info = extractUncoveredGuideQuestions(matchedJobGuide.content, recentHistory);
  } else if (Array.isArray(next.next_missing_info)) {
    next.next_missing_info = [];
  }
  return next;
}

function buildBatchText(items, { beforeSendRegeneration = false } = {}) {
  const prefix = beforeSendRegeneration
    ? [
        "发送前发现候选人又补充了新消息。上一版回复还没有发出，请忽略未发送的旧回复，结合下面全部消息重新生成一次最终回复：",
        "",
      ]
    : [];

  return items.length === 1 && !beforeSendRegeneration
    ? items[0].text
    : [
        ...prefix,
        "候选人连续发来了多条消息，请合并理解后一次性回复：",
        "",
        ...items.map((item, index) => `${index + 1}. ${item.text}`),
      ].join("\n");
}

async function fetchNewItemsBeforeSend({ token, openKfid, externalUserId, knownIds }) {
  const result = await syncMessages({ token, openKfid });
  const messages = Array.isArray(result.msg_list) ? result.msg_list : [];
  const newerItems = messages
    .map(normalizeMessage)
    .filter(Boolean)
    .filter((item) => !state.processedMsgIds.includes(item.msgId))
    .filter((item) => !knownIds.has(item.msgId))
    .filter((item) => item.openKfid === openKfid && item.externalUserId === externalUserId);

  if (newerItems.length > 0) {
    log(`[wecom-kf] pre-send sync_msg found ${newerItems.length} newer candidate message(s)`);
  }

  return newerItems;
}

function saveFinalConversationAndAssessment({
  externalUserId,
  text,
  reply,
  replyParts,
  candidateUpdate,
}) {
  const safeExternalUserId = safeId(externalUserId);
  const historyPath = path.join(stateDir, `history-${safeExternalUserId}.json`);

  let history = [];
  try {
    const loaded = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    if (Array.isArray(loaded)) history = loaded;
  } catch {
    history = [];
  }

  history.push({ role: "候选人", text, at: new Date().toISOString() });

  if (reply && !/^NO_REPLY$/i.test(reply)) {
    const sentParts = Array.isArray(replyParts) && replyParts.length > 0 ? replyParts : [reply];
    const at = new Date().toISOString();
    for (const part of sentParts) {
      history.push({ role: "HR", text: part, at });
    }
  }

  fs.writeFileSync(historyPath, JSON.stringify(history.slice(-60), null, 2), "utf8");

  if (candidateUpdate) {
    saveCandidateRecord({
      safeExternalUserId,
      externalUserId,
      update: candidateUpdate,
      lastCandidateMessage: text,
      lastReply: reply || "",
    });
  }
}

function saveHrConversation({ externalUserId, reply }) {
  const safeExternalUserId = safeId(externalUserId);
  const historyPath = path.join(stateDir, `history-${safeExternalUserId}.json`);
  const history = loadCandidateHistory(safeExternalUserId);
  history.push({ role: "HR", text: reply, at: new Date().toISOString() });
  fs.writeFileSync(historyPath, JSON.stringify(history.slice(-60), null, 2), "utf8");
  saveCandidateRecord({
    safeExternalUserId,
    externalUserId,
    update: { stage: "初始沟通" },
    lastCandidateMessage: "",
    lastReply: reply,
  });
}

function parseAgentJsonReply(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return { reply: "", candidateUpdate: null };

  const normalized = stripMarkdownJsonFence(raw);
  const parsed =
    tryParseJsonObject(normalized) || tryParseJsonObject(extractJsonObject(normalized));
  if (parsed) {
    const reply = String(parsed.reply || parsed.message || parsed.text || "").trim();
    const candidateUpdate =
      parsed.candidate_update ||
      parsed.candidateUpdate ||
      parsed.candidate_record ||
      parsed.candidateRecord ||
      null;
    const actions = normalizeAgentActions(parsed.actions || parsed.action || {});
    if (looksLikeInternalLeak(reply)) {
      log("[wecom-kf] agent reply looked like internal assessment; reply suppressed");
      return {
        reply: "",
        candidateUpdate:
          candidateUpdate && typeof candidateUpdate === "object" ? candidateUpdate : null,
        actions,
      };
    }
    return {
      reply: reply || "NO_REPLY",
      candidateUpdate:
        candidateUpdate && typeof candidateUpdate === "object" ? candidateUpdate : null,
      actions,
    };
  }

  const salvagedReply =
    extractStringField(normalized, "reply") ||
    extractStringField(normalized, "message") ||
    extractStringField(normalized, "text");
  if (salvagedReply) {
    if (looksLikeInternalLeak(salvagedReply)) {
      log("[wecom-kf] salvaged reply looked like internal assessment; reply suppressed");
      return { reply: "", candidateUpdate: null };
    }
    log("[wecom-kf] salvaged reply from malformed agent JSON");
    return { reply: salvagedReply, candidateUpdate: null, actions: {} };
  }

  if (looksLikeJsonObject(raw) || looksLikeInternalLeak(raw)) {
    log(
      "[wecom-kf] agent returned malformed internal JSON; reply suppressed to avoid leaking assessment",
    );
    return { reply: "", candidateUpdate: null, actions: {} };
  }

  return { reply: raw, candidateUpdate: null, actions: {} };
}

function normalizeAgentActions(actions) {
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) return {};
  return {
    sendProjectPlanningTestPdf:
      actions.send_project_planning_test_pdf === true ||
      actions.sendProjectPlanningTestPdf === true,
  };
}

function stripMarkdownJsonFence(text) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return "";
  return text.slice(start, end + 1);
}

function tryParseJsonObject(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractStringField(text, fieldName) {
  const source = String(text || "");
  const pattern = new RegExp(`["']?${escapeRegExp(fieldName)}["']?\\s*:`, "i");
  const match = pattern.exec(source);
  if (!match) return "";

  let index = match.index + match[0].length;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (index >= source.length) return "";

  const quote = source[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    let value = "";
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        const next = source[index + 1];
        if (next === "n") value += "\n";
        else if (next === "r") value += "\r";
        else if (next === "t") value += "\t";
        else if (next) value += next;
        index += 2;
        continue;
      }
      if (char === quote) return value.trim();
      value += char;
      index += 1;
    }
    return value.trim();
  }

  const endMatch = /[,}\n\r]/.exec(source.slice(index));
  const end = endMatch ? index + endMatch.index : source.length;
  return source.slice(index, end).trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeJsonObject(text) {
  const value = String(text || "").trim();
  return /^\{[\s\S]*\}$/.test(value) || /"reply"\s*:/.test(value) || /'reply'\s*:/.test(value);
}

function looksLikeInternalLeak(text) {
  return /candidate_update|candidateUpdate|candidate_record|candidateRecord|assessment|score|评分|加分|减分|总分|等级|内部简评|内部资料/i.test(
    String(text || ""),
  );
}

function loadCandidateAssessments() {
  try {
    const loaded = JSON.parse(fs.readFileSync(candidateAssessmentPath, "utf8"));
    return loaded && typeof loaded === "object" && !Array.isArray(loaded)
      ? { candidates: {}, ...loaded }
      : { candidates: {} };
  } catch (err) {
    if (err && err.code === "ENOENT") return { candidates: {} };
    markCandidateAssessmentsBroken(err);
    return { candidates: {} };
  }
}

function markCandidateAssessmentsBroken(err) {
  if (candidateAssessmentsBroken) return;
  candidateAssessmentsBroken = true;
  const backupPath = `${candidateAssessmentPath}.broken-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  try {
    if (fs.existsSync(candidateAssessmentPath)) {
      fs.copyFileSync(candidateAssessmentPath, backupPath);
      log(
        `[wecom-kf] candidate assessment JSON is unreadable; backed up to ${backupPath}; candidate updates will be skipped until the JSON is fixed: ${err.message || err}`,
      );
      return;
    }
  } catch (backupErr) {
    log(
      `[wecom-kf] candidate assessment JSON is unreadable and backup failed; candidate updates will be skipped until the JSON is fixed: ${backupErr.message || backupErr}`,
    );
    return;
  }
  log(
    `[wecom-kf] candidate assessment JSON is unreadable; candidate updates will be skipped until the JSON is fixed: ${err.message || err}`,
  );
}

function loadPromptFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (err) {
    console.error(`[wecom-kf] prompt file not loaded: ${filePath}: ${err.message || err}`);
    return "";
  }
}

function extractPromptSection(content, heading) {
  const lines = String(content || "").split(/\r\n|\n|\r/u);
  const target = String(heading || "").trim();
  let headingLevel = 0;
  let startIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[i].trim());
    if (!match) continue;
    if (match[2].trim() === target) {
      headingLevel = match[1].length;
      startIndex = i + 1;
      break;
    }
  }

  if (startIndex < 0) return "";
  const section = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(lines[i].trim());
    if (match && match[1].length <= headingLevel) break;
    section.push(lines[i]);
  }
  return section.join("\n").trim();
}

function loadJobGuides(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => {
      const lowerName = name.toLowerCase();
      return name.endsWith(".md") && lowerName !== "readme.md" && !name.startsWith("_");
    })
    .map((fileName) => {
      const content = fs.readFileSync(path.join(dir, fileName), "utf8").trim();
      const aliases = parseJobGuideAliases(content, fileName);
      return { aliases, content, fileName };
    })
    .filter((guide) => guide.aliases.length > 0 && guide.content);
}

function parseJobGuideAliases(content, fileName) {
  const aliasLine = content
    .split(/\r\n|\n|\r/u)
    .find((line) => /^(岗位别名|aliases)\s*[:：]/iu.test(line.trim()));
  if (!aliasLine && fileName.toLowerCase() === "sales.md") {
    return ["sales", "销售", "销售岗"];
  }
  const values = aliasLine
    ? aliasLine.replace(/^(岗位别名|aliases)\s*[:：]\s*/iu, "")
    : fileName.replace(/\.md$/iu, "");
  return values
    .split(/[、,，/|]/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function selectJobGuide({ candidateRecord, recentHistory, text }) {
  const haystack = [
    text,
    recentHistory,
    candidateRecord?.position,
    candidateRecord?.role,
    candidateRecord?.stage,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return jobGuides.find((guide) => guide.aliases.some((alias) => haystack.includes(alias)));
}

function isTimeoutError(err) {
  return Boolean(
    err &&
    (err.code === "ETIMEDOUT" ||
      err.killed === true ||
      /timed?\s*out|timeout/i.test(String(err.message || ""))),
  );
}

function buildFastFallbackReply({ candidateRecord, matchedJobGuide, recentHistory, text }) {
  const historyText = [recentHistory, text].filter(Boolean).join("\n");
  const askedGuideQuestions = matchedJobGuide
    ? getAskedGuideQuestions(candidateRecord, matchedJobGuide.fileName)
    : [];
  const guideQuestion = matchedJobGuide
    ? pickNextGuideQuestion(matchedJobGuide.content, historyText, askedGuideQuestions)
    : "";
  if (guideQuestion) return guideQuestion;

  return "你应聘的是哪个岗位？";
}

async function rewriteContradictoryPersonalFollowup({ externalUserId, reply, text }) {
  const value = String(reply || "").trim();
  if (!value || /^NO_REPLY$/i.test(value)) return value;
  if (!replyJudgeEnabled) return value;

  const safeExternalUserId = safeId(externalUserId);
  const history = loadCandidateHistory(safeExternalUserId);
  const recentHistory = history
    .slice(-30)
    .map((item) => `${item.role}：${item.text}`)
    .join("\n");
  const historyText = [recentHistory, text].filter(Boolean).join("\n");
  const candidateRecord = loadCandidateRecord(safeExternalUserId);
  const matchedJobGuide = selectJobGuide({
    candidateRecord,
    recentHistory,
    text,
  });

  if (!shouldReviewRepeatedQuestion(value, recentHistory, text)) return value;

  const askedGuideQuestions = matchedJobGuide
    ? getAskedGuideQuestions(candidateRecord, matchedJobGuide.fileName)
    : [];
  const nextQuestion = matchedJobGuide
    ? pickNextGuideQuestion(matchedJobGuide.content, historyText, askedGuideQuestions)
    : "";
  const decision = await judgeReplyAgainstRecentAnswers({
    recentHistory,
    candidateMessage: text,
    proposedReply: value,
    nextQuestion,
  });

  if (decision.action === "replace" && decision.reply) {
    log("[wecom-kf] model replaced repeated/answered followup");
    return decision.reply;
  }
  if (decision.action === "suppress") {
    log("[wecom-kf] model suppressed repeated/answered followup");
    return "NO_REPLY";
  }
  return value;
}

function shouldReviewRepeatedQuestion(question, recentHistory, text) {
  const value = String(question || "");
  if (!value) return false;
  const combined = [recentHistory, text].filter(Boolean).join("\n");
  const normalizedCombined = normalizeQuestionText(combined);
  if (asksQuestion(value) && resemblesRecentHrQuestion(value, recentHistory)) return true;
  if (hasMultipleQuestionMarks(value)) return true;
  if (replyAsksChildDetails(value) && indicatesNoChildren({ recentHistory, text })) return true;
  if (replyAsksFamilyPersonal(value) && indicatesFamilyPushback({ recentHistory, text }))
    return true;
  return (
    isFamilyQuestionCoveredByHistory(value, normalizedCombined) && replyAsksFamilyPersonal(value)
  );
}

async function judgeReplyAgainstRecentAnswers({
  recentHistory,
  candidateMessage,
  proposedReply,
  nextQuestion,
}) {
  const messagePath = path.join(
    stateDir,
    `judge-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const prompt = [
    "你是企业微信招聘面试回复质检器。",
    "只判断 proposed_reply 是否在重复追问候选人已经回答过的问题，或没有理解候选人刚才的意思。",
    "必须只输出合法 JSON，不要 Markdown，不要额外文字。",
    "",
    "判断原则：",
    "1. 如果候选人已经明确回答了某个问题，proposed_reply 还在继续问同一个意思，action=replace 或 suppress。",
    "2. 如果候选人说没有小孩/没孩子，继续问几个、多大、谁带属于重复追问。",
    "3. 如果候选人表示问题和岗位无关或不愿回答家庭隐私，继续追问家庭/婚育/配偶属于重复追问。",
    "4. 如果 proposed_reply 合理追问尚未回答的关键信息，action=send。",
    "5. 如果需要替换，优先使用 next_question；如果 next_question 也不合适，action=suppress。",
    "",
    "JSON 输出格式：",
    JSON.stringify(
      {
        action: "send | replace | suppress",
        reply: "action=replace 时填写要发送的新问题，否则填空字符串",
        reason: "简短说明，内部日志用，不发给候选人",
      },
      null,
      2,
    ),
    "",
    "recent_history:",
    recentHistory || "暂无",
    "",
    "candidate_message:",
    candidateMessage || "",
    "",
    "proposed_reply:",
    proposedReply || "",
    "",
    "next_question:",
    nextQuestion || "",
  ].join("\n");

  fs.writeFileSync(messagePath, prompt, "utf8");

  const args = [
    "scripts/run-node.mjs",
    "--dev",
    "agent",
    "--agent",
    agentId,
    "--local",
    "--session-key",
    `agent:${agentId}:wecom-kf-reply-judge`,
    "--message-file",
    messagePath,
    "--json",
    "--timeout",
    String(Math.ceil(replyJudgeTimeoutMs / 1000)),
  ];

  try {
    const output = await execFile(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      timeout: replyJudgeTimeoutMs,
    });
    return normalizeReplyJudgeDecision(extractAgentJsonText(output), nextQuestion);
  } catch (err) {
    log(`[wecom-kf] reply judge failed; falling back to next question: ${err.message || err}`);
    return buildReplyJudgeFallback(nextQuestion);
  } finally {
    try {
      fs.unlinkSync(messagePath);
    } catch {}
  }
}

function buildReplyJudgeFallback(nextQuestion) {
  const reply = nextQuestion ? `好的\n\n${nextQuestion}` : "好的";
  return { action: "replace", reply, reason: "judge failed" };
}

function normalizeReplyJudgeDecision(rawText, nextQuestion) {
  const parsed =
    tryParseJsonObject(stripMarkdownJsonFence(rawText)) ||
    tryParseJsonObject(extractJsonObject(rawText)) ||
    {};
  const action = String(parsed.action || "").toLowerCase();
  if (action === "replace") {
    const reply = String(parsed.reply || nextQuestion || "").trim();
    return reply
      ? { action: "replace", reply, reason: String(parsed.reason || "") }
      : { action: "suppress", reply: "", reason: String(parsed.reason || "") };
  }
  if (action === "suppress") {
    return { action: "suppress", reply: "", reason: String(parsed.reason || "") };
  }
  return { action: "send", reply: "", reason: String(parsed.reason || "") };
}

function hasMultipleQuestionMarks(value) {
  const matches = String(value || "").match(/[？?]/g);
  return Boolean(matches && matches.length >= 2);
}

function asksQuestion(value) {
  return (
    /[？?]/u.test(value) ||
    /(说下|介绍|了解|方便|是否|有没有|哪里|多少|多久|什么|怎么|哪)/u.test(String(value || ""))
  );
}

function resemblesRecentHrQuestion(question, recentHistory) {
  const normalizedQuestion = normalizeQuestionText(question);
  if (!normalizedQuestion) return false;
  return String(recentHistory || "")
    .split(/\r\n|\n|\r/u)
    .reverse()
    .slice(0, 12)
    .some((line) => {
      if (!line.startsWith("HR：")) return false;
      const normalizedLine = normalizeQuestionText(line.replace(/^HR：/u, ""));
      if (!normalizedLine) return false;
      const questionProbe = normalizedQuestion.slice(0, Math.min(12, normalizedQuestion.length));
      const lineProbe = normalizedLine.slice(0, Math.min(12, normalizedLine.length));
      return normalizedLine.includes(questionProbe) || normalizedQuestion.includes(lineProbe);
    });
}

function replyAsksChildDetails(value) {
  return (
    /(小孩|孩子|娃|宝宝)/u.test(value) && /(几个|几岁|多大|谁带|情况|有没有|有几个)/u.test(value)
  );
}

function replyAsksFamilyPersonal(value) {
  return /(家庭|结婚|婚育|小孩|孩子|老公|配偶|老婆|对象)/u.test(value);
}

function indicatesNoChildren({ recentHistory, text }) {
  const normalizedText = normalizeQuestionText(text);
  const normalizedHistory = normalizeQuestionText(recentHistory);
  if (/(没有小孩|没小孩|无小孩|没有孩子|没孩子|无孩子|没有娃|没娃|无娃)/u.test(normalizedText)) {
    return true;
  }
  if (
    /^(没有|没|无|暂无|暂时没有)$/u.test(normalizedText) &&
    recentHrAskedChildDetails(recentHistory)
  ) {
    return true;
  }
  return /(没有小孩|没小孩|无小孩|没有孩子|没孩子|无孩子|没有娃|没娃|无娃)/u.test(
    normalizedHistory,
  );
}

function indicatesFamilyPushback({ recentHistory, text }) {
  const normalizedText = normalizeQuestionText(text);
  if (
    !/(岗位无关|和岗位无关|跟岗位无关|这个岗位无关|无关吧|不相关|不方便|隐私)/u.test(normalizedText)
  ) {
    return false;
  }
  return (
    replyAsksFamilyPersonal(recentHistory) ||
    /(家庭|小孩|孩子|老公|配偶|婚育)/u.test(normalizedText)
  );
}

function recentHrAskedChildDetails(recentHistory) {
  const lines = String(recentHistory || "")
    .split(/\r\n|\n|\r/u)
    .reverse()
    .slice(0, 6);
  return lines.some((line) => line.startsWith("HR：") && replyAsksChildDetails(line));
}

function pickNextGuideQuestion(content, historyText, askedQuestions = []) {
  const questions = extractGuideQuestions(content);
  const normalizedHistory = normalizeQuestionText(historyText);
  const askedQuestionSet = new Set(
    (Array.isArray(askedQuestions) ? askedQuestions : [])
      .map((question) => normalizeQuestionText(question))
      .filter(Boolean),
  );
  return (
    questions.find((question) => {
      if (askedQuestionSet.has(normalizeQuestionText(question))) return false;
      return !isGuideQuestionCoveredByHistory(question, normalizedHistory);
    }) || ""
  );
}

function countAskedGuideQuestions(content, historyText) {
  const normalizedHistory = normalizeQuestionText(historyText);
  return extractGuideQuestions(content).filter((question) =>
    isExactGuideQuestionInHistory(question, normalizedHistory),
  ).length;
}

function extractUncoveredGuideQuestions(content, historyText) {
  const normalizedHistory = normalizeQuestionText(historyText);
  return extractGuideQuestions(content).filter(
    (question) => !isGuideQuestionCoveredByHistory(question, normalizedHistory),
  );
}

function isGuideQuestionCoveredByHistory(question, normalizedHistory) {
  return (
    isExactGuideQuestionInHistory(question, normalizedHistory) ||
    isGuideQuestionTopicCoveredByHistory(question, normalizedHistory) ||
    isLocationQuestionCoveredByHistory(question, normalizedHistory) ||
    isFamilyQuestionCoveredByHistory(question, normalizedHistory)
  );
}

function isExactGuideQuestionInHistory(question, normalizedHistory) {
  const normalizedQuestion = normalizeQuestionText(question);
  if (!normalizedQuestion) return false;
  const probe = normalizedQuestion.slice(0, Math.min(12, normalizedQuestion.length));
  if (normalizedHistory.includes(probe)) return true;

  const relaxedQuestion = relaxQuestionText(normalizedQuestion);
  const relaxedHistory = relaxQuestionText(normalizedHistory);
  const relaxedProbe = relaxedQuestion.slice(0, Math.min(12, relaxedQuestion.length));
  return Boolean(relaxedProbe && relaxedHistory.includes(relaxedProbe));
}

function relaxQuestionText(value) {
  return String(value || "").replace(/那|方便|说下|说一下|了解下|了解一下|及|和|与/g, "");
}

function isGuideQuestionTopicCoveredByHistory(question, normalizedHistory) {
  const normalizedQuestion = normalizeQuestionText(question);
  if (!normalizedQuestion || !normalizedHistory) return false;

  if (/行业/u.test(normalizedQuestion) && /(产品|业务|主营|服务)/u.test(normalizedQuestion)) {
    return (
      /(行业|呆过|待过|做过)/u.test(normalizedHistory) &&
      /(产品|业务|主营|服务|卖什么)/u.test(normalizedHistory)
    );
  }

  if (/(客户构成|客户业绩|占比|大c|小c|大b|小b|大g|小g)/u.test(normalizedQuestion)) {
    return (
      /(客户构成|客户主要|偏什么端|客户业绩|占比|大c|小c|大b|小b|大g|小g)/u.test(
        normalizedHistory,
      ) && /(客户|大c|小c|大b|小b|大g|小g)/u.test(normalizedHistory)
    );
  }

  return false;
}

function isLocationQuestionCoveredByHistory(question, normalizedHistory) {
  if (!/(住在哪里|居住|地铁站|住哪|在哪住)/u.test(question)) return false;
  return /(住在哪里|居住|地铁站|住哪|在哪住)/u.test(normalizedHistory);
}

function isFamilyQuestionCoveredByHistory(question, normalizedHistory) {
  if (!/(家庭|结婚|婚育|小孩|孩子|老公|配偶)/u.test(question)) return false;
  return (
    /(没有小孩|没小孩|无小孩|没有孩子|没孩子|无孩子|没有娃|没娃|无娃)/u.test(normalizedHistory) ||
    /(小孩|孩子|娃|宝宝).{0,80}(没有|没|无|暂无|暂时没有)/u.test(normalizedHistory) ||
    /(岗位无关|和岗位无关|跟岗位无关|这个岗位无关|无关吧|不相关|不方便)/u.test(normalizedHistory)
  );
}

function hasSentOpeningIntro(history) {
  const normalizedHistory = normalizeQuestionText(
    history
      .filter((item) => item.role === "HR")
      .map((item) => item.text)
      .join("\n"),
  );
  const intro = normalizeQuestionText(openingIntroMessage());
  const probe = intro.slice(0, Math.min(18, intro.length));
  return normalizedHistory.includes(probe);
}

function extractGuideQuestions(content) {
  const lines = String(content || "").split(/\r\n|\n|\r/u);
  const questions = [];
  let inQuestionBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("题目：")) {
      inQuestionBlock = true;
      const inlineQuestion = trimmed.replace(/^题目：\s*/u, "");
      questions.push(...splitNumberedQuestions(inlineQuestion));
      continue;
    }
    if (trimmed.startsWith("分值：")) {
      inQuestionBlock = false;
      continue;
    }
    if (inQuestionBlock && trimmed) {
      questions.push(...splitNumberedQuestions(trimmed));
    }
  }

  return questions;
}

function splitNumberedQuestions(value) {
  return String(value || "")
    .split(/(?=\d+[.,，、])/u)
    .map((item) => item.trim().replace(/^\d+[.,，、]\s*/u, ""))
    .filter(Boolean);
}

function normalizeQuestionText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function getAskedGuideQuestions(candidateRecord, guideFileName) {
  const byGuide = candidateRecord?.asked_guide_questions;
  const questions =
    byGuide && typeof byGuide === "object" && !Array.isArray(byGuide) ? byGuide[guideFileName] : [];
  return Array.isArray(questions) ? questions.filter((item) => typeof item === "string") : [];
}

function loadCandidateRecord(safeExternalUserId) {
  const assessments = loadCandidateAssessments();
  return assessments.candidates && typeof assessments.candidates === "object"
    ? assessments.candidates[safeExternalUserId] || null
    : null;
}

function loadCandidateHistory(safeExternalUserId) {
  const historyPath = path.join(stateDir, `history-${safeExternalUserId}.json`);
  try {
    const loaded = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    return Array.isArray(loaded) ? loaded : [];
  } catch {
    return [];
  }
}

function saveCandidateRecord({
  safeExternalUserId,
  externalUserId,
  update,
  lastCandidateMessage,
  lastReply,
}) {
  if (candidateAssessmentsBroken) {
    log(
      `[wecom-kf] candidate assessment update skipped because ${candidateAssessmentPath} is unreadable; fix or restore the JSON first`,
    );
    return;
  }
  const assessments = loadCandidateAssessments();
  if (candidateAssessmentsBroken) {
    log(
      `[wecom-kf] candidate assessment update skipped because ${candidateAssessmentPath} became unreadable while loading`,
    );
    return;
  }
  const candidates =
    assessments.candidates && typeof assessments.candidates === "object"
      ? assessments.candidates
      : {};
  const current =
    candidates[safeExternalUserId] && typeof candidates[safeExternalUserId] === "object"
      ? candidates[safeExternalUserId]
      : {};
  const now = new Date().toISOString();
  const next = mergeCandidateRecord(current, update);
  backfillAskedGuideQuestionsFromHistory({
    record: next,
    safeExternalUserId,
  });

  next.externalUserId = externalUserId;
  next.safeId = safeExternalUserId;
  next.updatedAt = now;
  next.lastCandidateMessage = lastCandidateMessage;
  next.lastReply = lastReply || "";

  candidates[safeExternalUserId] = next;
  assessments.candidates = candidates;
  assessments.updatedAt = now;
  writeJsonFileAtomic(candidateAssessmentPath, assessments);
  log(`[wecom-kf] candidate assessment updated: ${candidateAssessmentPath}`);
}

function writeJsonFileAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function mergeCandidateRecord(current, update) {
  if (!update || typeof update !== "object" || Array.isArray(update)) return current || {};
  const merged = deepMerge(current || {}, update);
  if (Object.prototype.hasOwnProperty.call(update, "next_missing_info")) {
    merged.next_missing_info = Array.isArray(update.next_missing_info)
      ? update.next_missing_info
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(update, "asked_guide_questions")) {
    merged.asked_guide_questions = mergeAskedGuideQuestions(
      current?.asked_guide_questions,
      update.asked_guide_questions,
    );
  }
  return merged;
}

function mergeAskedGuideQuestions(current, update) {
  const result =
    current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  if (!update || typeof update !== "object" || Array.isArray(update)) return result;

  for (const [guideFileName, questions] of Object.entries(update)) {
    const existing = Array.isArray(result[guideFileName]) ? result[guideFileName] : [];
    const additions = Array.isArray(questions) ? questions : [];
    const seen = new Set();
    result[guideFileName] = [...existing, ...additions]
      .filter((question) => typeof question === "string" && question.trim())
      .filter((question) => {
        const key = normalizeQuestionText(question);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  return result;
}

function backfillAskedGuideQuestionsFromHistory({ record, safeExternalUserId }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const history = loadCandidateHistory(safeExternalUserId);
  if (history.length === 0) return;

  const currentByGuide =
    record.asked_guide_questions &&
    typeof record.asked_guide_questions === "object" &&
    !Array.isArray(record.asked_guide_questions)
      ? record.asked_guide_questions
      : {};
  let nextByGuide = currentByGuide;

  for (const guide of jobGuides) {
    const asked = new Set(
      getAskedGuideQuestions(record, guide.fileName).map(normalizeQuestionText),
    );
    const guideQuestions = extractGuideQuestions(guide.content);
    const sentHrQuestions = history
      .filter((item) => item.role === "HR")
      .map((item) => String(item.text || ""));
    const additions = guideQuestions.filter((question) => {
      const normalizedQuestion = normalizeQuestionText(question);
      if (!normalizedQuestion || asked.has(normalizedQuestion)) return false;
      return sentHrQuestions.some((sent) =>
        normalizeQuestionText(sent).includes(normalizedQuestion),
      );
    });
    if (additions.length === 0) continue;

    nextByGuide = mergeAskedGuideQuestions(nextByGuide, {
      [guide.fileName]: additions,
    });
  }

  record.asked_guide_questions = nextByGuide;
}

function deepMerge(base, update) {
  if (Array.isArray(update)) {
    return update.length > 0 ? update : Array.isArray(base) ? base : [];
  }
  if (!update || typeof update !== "object") {
    if (update === null || update === "") return base ?? update;
    return update;
  }

  const result = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(update)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
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

function splitOutboundReply(text, { reserveSlots = 0 } = {}) {
  const cleaned = sanitizeOutboundText(text);
  if (!cleaned) return [];

  const maxParts = Math.max(1, 5 - Number(reserveSlots || 0));
  const parts = cleaned
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return [cleaned];
  if (parts.length <= maxParts) return parts;

  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join("\n\n")];
}

function randomReplyPartDelayMs() {
  const min = Math.max(0, Math.min(replyPartDelayMinMs, replyPartDelayMaxMs));
  const max = Math.max(min, replyPartDelayMinMs, replyPartDelayMaxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sanitizeOutboundText(text) {
  return stripConfirmationLead(String(text || ""))
    .replace(/他\s*[\/／]\s*她/g, "他")
    .replace(/他[（(]\s*她\s*[)）]/g, "他")
    .replace(/她\s*[\/／]\s*他/g, "他")
    .replace(/她[（(]\s*他\s*[)）]/g, "他")
    .trim();
}

function stripConfirmationLead(text) {
  let value = String(text || "").trimStart();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(
      /^\s*[^\n。！？!?]{0,80}(?:记下了|记录了|已记录|清楚了|明确了|收到了|了解了)[^\n。！？!?]*[。！？!?]?\s*/u,
      "",
    );
    if (next === value) return value;
    value = next.trimStart();
  }
  return value;
}

async function sendProjectPlanningTestPdf({ openKfid, externalUserId }) {
  if (!fs.existsSync(projectPlanningTestPdfPath)) {
    throw new Error(`project planning test PDF is missing: ${projectPlanningTestPdfPath}`);
  }

  const stat = fs.statSync(projectPlanningTestPdfPath);
  const maxBytes = 20 * 1024 * 1024;
  if (!stat.isFile()) {
    throw new Error(`project planning test PDF path is not a file: ${projectPlanningTestPdfPath}`);
  }
  if (stat.size <= 0) {
    throw new Error(`project planning test PDF is empty: ${projectPlanningTestPdfPath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `project planning test PDF is too large: ${stat.size} bytes, max ${maxBytes} bytes`,
    );
  }

  const mediaId = await uploadTempMedia({
    filePath: projectPlanningTestPdfPath,
    mediaType: "file",
    contentType: "application/pdf",
  });

  const accessToken = await getAccessToken();
  return wecomJson(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`,
    {
      touser: externalUserId,
      open_kfid: openKfid,
      msgtype: "file",
      file: { media_id: mediaId },
    },
  );
}

async function uploadTempMedia({ filePath, mediaType, contentType }) {
  const accessToken = await getAccessToken();
  const fileName = path.basename(filePath);
  const file = fs.readFileSync(filePath);
  const boundary = `----openclaw-${crypto.randomBytes(12).toString("hex")}`;
  const head = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="media"; filename="${escapeHeaderValue(fileName)}"`,
      `Content-Type: ${contentType || "application/octet-stream"}`,
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const bodyBuffer = Buffer.concat([head, file, tail]);

  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(mediaType)}`,
    {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(bodyBuffer.length),
      },
      body: bodyBuffer,
    },
  );
  const body = await res.json();
  if (body.errcode !== 0 || !body.media_id) {
    throw new Error(`upload media failed: ${JSON.stringify(redact(body))}`);
  }
  return body.media_id;
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

function escapeHeaderValue(value) {
  return String(value).replace(/["\r\n]/g, "_");
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
