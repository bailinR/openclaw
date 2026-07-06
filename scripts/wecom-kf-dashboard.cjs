#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

const stateDir = path.resolve(
  process.env.WECOM_KF_STATE_DIR || path.join(os.homedir(), ".openclaw-wecom-kf"),
);
const bindHost = process.env.WECOM_KF_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.WECOM_KF_DASHBOARD_PORT || 19100);
const assessmentPath =
  process.env.WECOM_KF_CANDIDATE_ASSESSMENT_PATH ||
  process.env.WECOM_KF_ASSESSMENTS_PATH ||
  path.join(stateDir, "candidate-assessments.json");

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((err) => {
    console.error(`[wecom-kf-dashboard] request failed: ${err.message || err}`);
    sendJson(res, 500, { error: "internal error" });
  });
});

server.listen(port, bindHost, () => {
  console.log(`[wecom-kf-dashboard] listening on http://${bindHost}:${port}/`);
  console.log(`[wecom-kf-dashboard] reading state from ${stateDir}`);
});

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${bindHost}:${port}`);

  if (req.method !== "GET") {
    sendText(res, 405, "method not allowed", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/") {
    sendText(res, 200, renderPage(), "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/candidates") {
    sendJson(res, 200, readCandidateSnapshot());
    return;
  }

  sendText(res, 404, "not found", "text/plain; charset=utf-8");
}

function readCandidateSnapshot() {
  const histories = readHistories();
  const assessments = readAssessments();
  const assessmentById = indexAssessments(assessments);
  const ids = new Set([...histories.keys(), ...assessmentById.keys()]);

  const candidates = Array.from(ids)
    .map((id) => {
      const history = histories.get(id) || [];
      const assessment = assessmentById.get(id) || null;
      const lastMessage = history[history.length - 1] || null;
      return {
        id,
        displayName: displayNameForCandidate(id, assessment),
        updatedAt: latestTimestamp(history, assessment),
        messageCount: history.length,
        lastRole: readString(lastMessage?.role),
        lastText: readString(lastMessage?.text),
        status: readStatus(assessment),
        assessment,
        history,
      };
    })
    .sort((a, b) => compareTimestampDesc(a.updatedAt, b.updatedAt) || a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    stateDir,
    assessmentPath,
    candidates,
  };
}

function readHistories() {
  const result = new Map();
  for (const name of safeReaddir(stateDir)) {
    const match = /^history-(.+)\.json$/u.exec(name);
    if (!match) continue;

    const id = match[1];
    const value = readJson(path.join(stateDir, name));
    result.set(id, normalizeHistory(value));
  }
  return result;
}

function readAssessments() {
  const value = readJson(assessmentPath);
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];

  if (Array.isArray(value.candidates)) return value.candidates.filter(isRecord);
  if (isRecord(value.candidates)) return recordMapToAssessments(value.candidates);
  if (Array.isArray(value.assessments)) return value.assessments.filter(isRecord);
  if (isRecord(value.assessments)) return recordMapToAssessments(value.assessments);

  return Object.entries(value).map(([key, entry]) =>
    isRecord(entry) ? { id: key, ...entry } : { id: key, value: entry },
  );
}

function recordMapToAssessments(recordMap) {
  return Object.entries(recordMap).map(([key, entry]) =>
    isRecord(entry) ? { id: key, ...entry } : { id: key, value: entry },
  );
}

function indexAssessments(assessments) {
  const result = new Map();
  for (const entry of assessments) {
    const id = firstString(
      entry.id,
      entry.candidateId,
      entry.externalUserId,
      entry.external_userid,
      entry.userId,
      entry.openUserId,
    );
    if (!id) continue;
    result.set(safeId(id), entry);
  }
  return result;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      role: readString(entry.role) || "unknown",
      text: readString(entry.text),
      at: readString(entry.at) || readString(entry.createdAt) || readString(entry.timestamp),
    }))
    .filter((entry) => entry.text || entry.at);
}

function displayNameForCandidate(id, assessment) {
  if (!isRecord(assessment)) return id;
  return (
    firstString(
      assessment.name,
      assessment.candidateName,
      assessment.realName,
      assessment.nickname,
      assessment.displayName,
    ) || id
  );
}

function readStatus(assessment) {
  if (!isRecord(assessment)) return "";
  return firstString(assessment.status, assessment.stage, assessment.result, assessment.decision) || "";
}

function latestTimestamp(history, assessment) {
  const historyAt = history
    .map((entry) => Date.parse(entry.at || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const assessmentAt = isRecord(assessment)
    ? Date.parse(
        firstString(assessment.updatedAt, assessment.updated_at, assessment.createdAt, assessment.at) || "",
      )
    : NaN;
  const latest = Math.max(historyAt || 0, Number.isFinite(assessmentAt) ? assessmentAt : 0);
  return latest > 0 ? new Date(latest).toISOString() : "";
}

function compareTimestampDesc(a, b) {
  const left = Date.parse(a || "");
  const right = Date.parse(b || "");
  return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeId(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80);
}

function firstString(...values) {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized) return normalized;
  }
  return "";
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function renderPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>企业微信求职者看板</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --line: #d8dee9;
      --text: #1d2733;
      --muted: #687588;
      --accent: #0f766e;
      --accent-soft: #e6f4f1;
      --danger-soft: #fff1f2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0;
    }
    button, input {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    .layout {
      height: calc(100vh - 56px);
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(420px, 1fr) minmax(380px, 520px);
      min-height: 520px;
    }
    aside, main, section {
      min-width: 0;
      overflow: hidden;
    }
    aside {
      border-right: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      outline: none;
    }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .list {
      overflow: auto;
      padding: 8px;
    }
    .candidate {
      width: 100%;
      display: block;
      text-align: left;
      border: 1px solid transparent;
      background: transparent;
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 4px;
    }
    .candidate.active {
      background: var(--accent-soft);
      border-color: #9bd0c8;
    }
    .candidate-name {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-weight: 650;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      max-width: 120px;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      color: #0f5f59;
      background: var(--accent-soft);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .candidate-meta, .candidate-last, .muted {
      color: var(--muted);
      font-size: 12px;
    }
    .candidate-last {
      margin-top: 6px;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      line-height: 1.45;
    }
    main {
      display: flex;
      flex-direction: column;
      background: #fbfcfe;
    }
    .pane-head {
      min-height: 62px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .pane-title {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
    }
    .conversation {
      flex: 1;
      overflow: auto;
      padding: 18px 24px;
    }
    .message {
      max-width: 78%;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .message.hr { margin-left: auto; align-items: flex-end; }
    .bubble {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.hr .bubble {
      border-color: #9bd0c8;
      background: var(--accent-soft);
    }
    .detail {
      border-left: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      flex-direction: column;
    }
    .detail-body {
      overflow: auto;
      padding: 14px;
    }
    .detail-section {
      border: 1px solid #e4e9f1;
      border-radius: 8px;
      background: #ffffff;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid #edf0f4;
      font-size: 14px;
      font-weight: 650;
      background: #f8fafc;
    }
    .section-body {
      padding: 10px 12px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .summary-card {
      min-height: 68px;
      border: 1px solid #e4e9f1;
      border-radius: 8px;
      padding: 9px 10px;
      background: #fbfcfe;
    }
    .summary-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .summary-value {
      font-size: 16px;
      font-weight: 650;
      line-height: 1.35;
      word-break: break-word;
    }
    .kv-grid {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      column-gap: 10px;
    }
    .kv-row {
      display: contents;
    }
    .kv-key, .kv-value {
      border-bottom: 1px solid #edf0f4;
      padding: 8px 0;
    }
    .kv-key {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }
    .kv-value {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      display: inline-flex;
      max-width: 100%;
      border-radius: 999px;
      padding: 4px 8px;
      background: var(--accent-soft);
      color: #0f5f59;
      font-size: 12px;
      line-height: 1.35;
      word-break: break-word;
    }
    .note-list {
      margin: 0;
      padding-left: 18px;
      line-height: 1.55;
    }
    .note-list li {
      margin: 4px 0;
      word-break: break-word;
    }
    .assessment-summary {
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .score-pill {
      border-radius: 999px;
      padding: 3px 8px;
      background: #fff7ed;
      color: #9a3412;
      font-size: 12px;
      white-space: nowrap;
    }
    .empty {
      margin: 24px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
    }
    .error {
      margin: 12px;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #fecdd3;
      background: var(--danger-soft);
      color: #9f1239;
    }
    @media (max-width: 1000px) {
      .layout {
        height: auto;
        grid-template-columns: 1fr;
      }
      aside, .detail {
        min-height: 260px;
        border-right: 0;
        border-left: 0;
        border-bottom: 1px solid var(--line);
      }
      main { min-height: 520px; }
      .message { max-width: 92%; }
      .summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>企业微信求职者看板</h1>
    <button id="refreshButton" type="button">刷新</button>
  </header>
  <div id="error" class="error" hidden></div>
  <div class="layout">
    <aside>
      <div class="toolbar">
        <input id="searchInput" placeholder="搜索姓名、岗位、状态、求职者 ID">
        <div id="summary" class="muted" style="margin-top:8px;"></div>
      </div>
      <div id="candidateList" class="list"></div>
    </aside>
    <main>
      <div class="pane-head">
        <h2 id="chatTitle" class="pane-title">选择求职者</h2>
        <div id="chatSubtitle" class="muted"></div>
      </div>
      <div id="conversation" class="conversation">
        <div class="empty">左侧选择一个求职者后查看对话。</div>
      </div>
    </main>
    <section class="detail">
      <div class="pane-head">
        <h2 class="pane-title">沉淀信息</h2>
        <div id="detailSubtitle" class="muted"></div>
      </div>
      <div id="details" class="detail-body">
        <div class="empty">暂无候选人信息。</div>
      </div>
    </section>
  </div>
  <script>
    const state = { data: null, selectedId: "", query: "" };
    const listEl = document.getElementById("candidateList");
    const searchInput = document.getElementById("searchInput");
    const conversationEl = document.getElementById("conversation");
    const detailsEl = document.getElementById("details");
    const chatTitle = document.getElementById("chatTitle");
    const chatSubtitle = document.getElementById("chatSubtitle");
    const detailSubtitle = document.getElementById("detailSubtitle");
    const summaryEl = document.getElementById("summary");
    const errorEl = document.getElementById("error");

    document.getElementById("refreshButton").addEventListener("click", () => load());
    searchInput.addEventListener("input", () => {
      state.query = searchInput.value.trim().toLowerCase();
      render();
    });

    load();

    async function load() {
      try {
        errorEl.hidden = true;
        const res = await fetch("/api/candidates", { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        state.data = await res.json();
        const candidates = state.data.candidates || [];
        if (!state.selectedId || !candidates.some((item) => item.id === state.selectedId)) {
          state.selectedId = candidates[0]?.id || "";
        }
        render();
      } catch (err) {
        errorEl.textContent = "读取失败：" + (err && err.message ? err.message : String(err));
        errorEl.hidden = false;
      }
    }

    function render() {
      const candidates = filteredCandidates();
      summaryEl.textContent = state.data
        ? "共 " + (state.data.candidates || []).length + " 位，当前显示 " + candidates.length + " 位"
        : "加载中";
      listEl.innerHTML = candidates.map(renderCandidateButton).join("") || '<div class="empty">没有匹配的求职者。</div>';
      for (const button of listEl.querySelectorAll("[data-id]")) {
        button.addEventListener("click", () => {
          state.selectedId = button.getAttribute("data-id");
          render();
        });
      }
      renderSelected();
    }

    function filteredCandidates() {
      const candidates = state.data?.candidates || [];
      if (!state.query) return candidates;
      return candidates.filter((candidate) =>
        searchableText(candidate).toLowerCase().includes(state.query)
      );
    }

    function searchableText(candidate) {
      return [
        candidate.id,
        candidate.displayName,
        candidate.status,
        candidate.lastText,
        JSON.stringify(candidate.assessment || {}),
      ].join(" ");
    }

    function renderCandidateButton(candidate) {
      const active = candidate.id === state.selectedId ? " active" : "";
      const status = candidate.status ? '<span class="badge">' + escapeHtml(candidate.status) + '</span>' : "";
      return '<button class="candidate' + active + '" type="button" data-id="' + escapeAttr(candidate.id) + '">' +
        '<div class="candidate-name"><span>' + escapeHtml(candidate.displayName || candidate.id) + '</span>' + status + '</div>' +
        '<div class="candidate-meta">' + escapeHtml(formatTime(candidate.updatedAt) || "无时间") + ' · ' + Number(candidate.messageCount || 0) + ' 条消息</div>' +
        '<div class="candidate-last">' + escapeHtml(candidate.lastText || "暂无消息") + '</div>' +
      '</button>';
    }

    function renderSelected() {
      const candidate = (state.data?.candidates || []).find((item) => item.id === state.selectedId);
      if (!candidate) {
        chatTitle.textContent = "选择求职者";
        chatSubtitle.textContent = "";
        detailSubtitle.textContent = "";
        conversationEl.innerHTML = '<div class="empty">左侧选择一个求职者后查看对话。</div>';
        detailsEl.innerHTML = '<div class="empty">暂无候选人信息。</div>';
        return;
      }
      chatTitle.textContent = candidate.displayName || candidate.id;
      chatSubtitle.textContent = candidate.id + (candidate.updatedAt ? " · 更新于 " + formatTime(candidate.updatedAt) : "");
      detailSubtitle.textContent = candidate.status || "";
      conversationEl.innerHTML = (candidate.history || []).map(renderMessage).join("") || '<div class="empty">暂无对话。</div>';
      detailsEl.innerHTML = renderAssessment(candidate.assessment);
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }

    function renderMessage(message) {
      const role = message.role || "unknown";
      const isHr = /HR|assistant|客服|招聘|面试官/i.test(role);
      return '<div class="message ' + (isHr ? "hr" : "candidate-msg") + '">' +
        '<div class="muted">' + escapeHtml(role) + (message.at ? " · " + escapeHtml(formatTime(message.at)) : "") + '</div>' +
        '<div class="bubble">' + escapeHtml(message.text || "") + '</div>' +
      '</div>';
    }

    function renderAssessment(assessment) {
      if (!assessment || typeof assessment !== "object") return '<div class="empty">暂无沉淀信息。</div>';
      const sections = [
        renderSummarySection(assessment),
        renderKnownInfoSection(assessment.known_info || assessment.knownInfo),
        renderAssessmentSection(assessment.assessment),
        renderListSection("候选人问题", assessment.candidate_questions || assessment.candidateQuestions),
        renderListSection("后续待补充", assessment.next_missing_info || assessment.nextMissingInfo),
        renderOtherSection(assessment),
      ].filter(Boolean);
      return sections.join("") || '<div class="empty">暂无沉淀信息。</div>';
    }

    function renderSummarySection(assessment) {
      const score = assessment.assessment && typeof assessment.assessment === "object"
        ? assessment.assessment.score
        : "";
      const level = assessment.assessment && typeof assessment.assessment === "object"
        ? assessment.assessment.level
        : "";
      const cards = [
        ["姓名", assessment.name || assessment.candidateName || assessment.realName],
        ["岗位", assessment.position || assessment.role],
        ["阶段", assessment.stage || assessment.status],
        ["评分", [score, level].filter(hasUsefulValue).join(" / ")],
      ];
      return '<div class="detail-section"><div class="section-title">核心概览</div>' +
        '<div class="section-body"><div class="summary-grid">' +
        cards.map(([label, value]) =>
          '<div class="summary-card"><div class="summary-label">' + escapeHtml(label) + '</div>' +
          '<div class="summary-value">' + escapeHtml(formatCompactValue(value)) + '</div></div>'
        ).join("") +
        '</div></div></div>';
    }

    function renderKnownInfoSection(knownInfo) {
      if (!knownInfo || typeof knownInfo !== "object") return "";
      const entries = orderedEntries(knownInfo, [
        "work_status",
        "education",
        "years_experience",
        "project_planning_experience",
        "representative_project",
        "planning_outputs",
        "tools",
        "collaboration",
        "sales_performance",
        "customer_type",
        "decision_level",
        "sales_cycle",
        "acquisition_channels",
        "salary_expectation",
      ]).filter(([, value]) => hasUsefulValue(value));
      if (!entries.length) return "";
      return renderKeyValueSection("已知信息", entries);
    }

    function renderAssessmentSection(assessment) {
      if (!assessment || typeof assessment !== "object") return "";
      const summary = assessment.summary ? '<div class="assessment-summary">' + escapeHtml(formatValue(assessment.summary)) + '</div>' : "";
      const score = [assessment.score, assessment.level].filter(hasUsefulValue).join(" / ");
      const titleExtra = score ? '<span class="score-pill">' + escapeHtml(score) + '</span>' : "";
      const plus = renderPoints("加分项", assessment.plus);
      const minus = renderPoints("减分项", assessment.minus);
      return '<div class="detail-section"><div class="section-title"><span>内部评估</span>' + titleExtra + '</div>' +
        '<div class="section-body">' + (summary || '<div class="muted">暂无简评</div>') + plus + minus + '</div></div>';
    }

    function renderPoints(title, items) {
      if (!Array.isArray(items) || items.length === 0) return "";
      const rendered = items
        .map((item) => {
          if (!item || typeof item !== "object") return formatValue(item);
          const points = hasUsefulValue(item.points) ? "（" + formatValue(item.points) + "分）" : "";
          const evidence = item.evidence ? "：" + formatValue(item.evidence) : "";
          return formatCompactValue(item.item || item.name || title) + points + evidence;
        })
        .filter(Boolean);
      if (!rendered.length) return "";
      return '<div style="margin-top:10px;"><div class="field-key">' + escapeHtml(title) + '</div>' +
        '<ul class="note-list">' + rendered.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul></div>';
    }

    function renderListSection(title, value) {
      const values = arrayValues(value);
      if (!values.length) return "";
      return '<div class="detail-section"><div class="section-title">' + escapeHtml(title) + '</div>' +
        '<div class="section-body"><ul class="note-list">' +
        values.map((item) => '<li>' + escapeHtml(formatValue(item)) + '</li>').join("") +
        '</ul></div></div>';
    }

    function renderOtherSection(assessment) {
      const hidden = new Set([
        "name",
        "candidateName",
        "realName",
        "position",
        "role",
        "stage",
        "status",
        "known_info",
        "knownInfo",
        "assessment",
        "candidate_questions",
        "candidateQuestions",
        "next_missing_info",
        "nextMissingInfo",
      ]);
      const entries = Object.entries(assessment)
        .filter(([key, value]) => !key.startsWith("_") && !hidden.has(key) && hasUsefulValue(value));
      if (!entries.length) return "";
      return renderKeyValueSection("其他记录", entries);
    }

    function renderKeyValueSection(title, entries) {
      return '<div class="detail-section"><div class="section-title">' + escapeHtml(title) + '</div>' +
        '<div class="section-body"><div class="kv-grid">' +
        entries.map(([key, value]) =>
          '<div class="kv-row"><div class="kv-key">' + escapeHtml(labelForKey(key)) + '</div>' +
          '<div class="kv-value">' + renderValue(value) + '</div></div>'
        ).join("") +
        '</div></div></div>';
    }

    function renderValue(value) {
      if (Array.isArray(value)) {
        const values = arrayValues(value);
        if (!values.length) return '<span class="muted">未填写</span>';
        return '<div class="chips">' + values.map((item) => '<span class="chip">' + escapeHtml(formatValue(item)) + '</span>').join("") + '</div>';
      }
      if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, nestedValue]) => hasUsefulValue(nestedValue));
        if (!entries.length) return '<span class="muted">未填写</span>';
        return entries.map(([key, nestedValue]) =>
          '<div><span class="muted">' + escapeHtml(labelForKey(key)) + '：</span>' + escapeHtml(formatValue(nestedValue)) + '</div>'
        ).join("");
      }
      return escapeHtml(formatValue(value));
    }

    function orderedEntries(record, preferredKeys) {
      const used = new Set();
      const ordered = [];
      for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          ordered.push([key, record[key]]);
          used.add(key);
        }
      }
      for (const entry of Object.entries(record)) {
        if (!used.has(entry[0])) ordered.push(entry);
      }
      return ordered;
    }

    function arrayValues(value) {
      if (!Array.isArray(value)) return hasUsefulValue(value) ? [value] : [];
      return value.filter(hasUsefulValue);
    }

    function hasUsefulValue(value) {
      if (value == null || value === "") return false;
      if (Array.isArray(value)) return value.some(hasUsefulValue);
      if (typeof value === "object") return Object.values(value).some(hasUsefulValue);
      return true;
    }

    function labelForKey(key) {
      const labels = {
        id: "求职者 ID",
        candidateId: "求职者 ID",
        externalUserId: "企业微信用户 ID",
        name: "姓名",
        candidateName: "姓名",
        status: "状态",
        stage: "阶段",
        position: "岗位",
        role: "岗位",
        city: "城市",
        location: "所在地",
        experience: "经验",
        salary: "期望薪资",
        expectedSalary: "期望薪资",
        salary_expectation: "薪资期望",
        skills: "技能",
        summary: "摘要",
        assessment: "评估",
        nextStep: "下一步",
        updatedAt: "更新时间",
        createdAt: "创建时间",
        safeId: "内部 ID",
        lastCandidateMessage: "最近求职者消息",
        lastReply: "最近回复",
        work_status: "当前状态",
        education: "学历专业",
        years_experience: "工作年限",
        project_planning_experience: "策划经验",
        representative_project: "代表项目",
        planning_outputs: "策划输出",
        tools: "常用工具",
        collaboration: "协作沟通",
        sales_performance: "销售业绩",
        customer_type: "客户类型",
        decision_level: "对接层级",
        sales_cycle: "成交周期",
        acquisition_channels: "获客方式",
      };
      return labels[key] || key;
    }

    function formatValue(value) {
      if (value == null || value === "") return "未填写";
      if (Array.isArray(value)) return value.map(formatValue).join("、");
      if (typeof value === "object") {
        return Object.entries(value)
          .filter(([, nestedValue]) => hasUsefulValue(nestedValue))
          .map(([key, nestedValue]) => labelForKey(key) + "：" + formatValue(nestedValue))
          .join("；") || "未填写";
      }
      return String(value);
    }

    function formatCompactValue(value) {
      const formatted = formatValue(value);
      return formatted === "未填写" ? "-" : formatted;
    }

    function formatTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString("zh-CN", { hour12: false });
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\`/g, "&#96;");
    }
  </script>
</body>
</html>`;
}
