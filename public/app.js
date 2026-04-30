const state = {
  tasks: [],
  activeTask: null,
  selectedFile: null,
  objectUrl: null,
  metrics: null,
  evidence: null,
  submissions: [],
  runTimer: null,
  runStartedAt: null,
  activeView: "setup"
};

const els = {
  viewTabs: document.querySelectorAll("[data-view-tab]"),
  viewPanels: document.querySelectorAll("[data-view-panel]"),
  taskList: document.querySelector("#taskList"),
  activeTaskDetail: document.querySelector("#activeTaskDetail"),
  taskPlanInput: document.querySelector("#taskPlanInput"),
  taskPlanButton: document.querySelector("#taskPlanButton"),
  taskPlanStatus: document.querySelector("#taskPlanStatus"),
  customTaskForm: document.querySelector("#customTaskForm"),
  spokenPromptField: document.querySelector("#spokenPromptField"),
  activeTitle: document.querySelector("#activeTitle"),
  healthDot: document.querySelector("#healthDot"),
  healthText: document.querySelector("#healthText"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  dropTitle: document.querySelector("#dropTitle"),
  fileMeta: document.querySelector("#fileMeta"),
  preview: document.querySelector("#preview"),
  analyzeButton: document.querySelector("#analyzeButton"),
  signalPanel: document.querySelector("#signalPanel"),
  verdictBadge: document.querySelector("#verdictBadge"),
  scoreValue: document.querySelector("#scoreValue"),
  summaryTitle: document.querySelector("#summaryTitle"),
  summaryText: document.querySelector("#summaryText"),
  hermesReview: document.querySelector("#hermesReview"),
  decisionMatrix: document.querySelector("#decisionMatrix"),
  evidencePack: document.querySelector("#evidencePack"),
  checks: document.querySelector("#checks"),
  modelSignals: document.querySelector("#modelSignals"),
  liveConsole: document.querySelector("#liveConsole"),
  liveBadge: document.querySelector("#liveBadge"),
  timeline: document.querySelector("#timeline"),
  reviewQueue: document.querySelector("#reviewQueue")
};

init();

async function init() {
  bindEvents();
  await checkHealth();
  await loadTasks();
  await refreshSubmissions();
}

function bindEvents() {
  els.viewTabs.forEach((button) => {
    button.addEventListener("click", () => setActiveView(button.dataset.viewTab));
  });

  els.fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (file) await selectFile(file);
  });

  els.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });

  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("dragging");
  });

  els.dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
    const [file] = event.dataTransfer.files;
    if (file) await selectFile(file);
  });

  els.analyzeButton.addEventListener("click", analyzeCurrentFile);

  els.taskPlanButton.addEventListener("click", planTaskWithHermes);

  els.customTaskForm.addEventListener("submit", createCustomTask);
  els.customTaskForm.elements.mediaKind.addEventListener("change", syncTaskFormForMedia);
  syncTaskFormForMedia();
}

function setActiveView(view) {
  state.activeView = view;
  els.viewTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.viewTab === view);
  });
  els.viewPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === view);
  });
}

async function checkHealth() {
  try {
    const health = await requestJson("/api/health");
    els.healthDot.classList.add("ok");
    els.healthText.textContent = health.hermes?.enabled ? "Hermes ready" : "Ready";
  } catch (error) {
    els.healthText.textContent = "Backend unavailable";
  }
}

async function loadTasks() {
  const data = await requestJson("/api/tasks");
  state.tasks = data.tasks;
  state.activeTask = state.tasks.find((task) => task.id === state.activeTask?.id) || state.tasks[0] || null;
  renderTasks();
  renderActiveTask();
  renderUploadPrompt();
}

async function refreshSubmissions() {
  const data = await requestJson("/api/submissions");
  state.submissions = data.submissions;
  renderSummary(data.summary);
  renderReviewQueue();
}

function renderTasks() {
  els.taskList.innerHTML = "";
  if (state.tasks.length === 0) {
    els.taskList.innerHTML = '<div class="empty-mini">No collection tasks yet. Plan one with Hermes, then create it.</div>';
    return;
  }

  for (const task of state.tasks) {
    const button = document.createElement("button");
    button.className = `task-button ${task.id === state.activeTask?.id ? "active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(task.name)}</strong>
      <span class="summary-meta">${escapeHtml(task.collection)} / ${escapeHtml(task.mediaKind)}</span>
      <span class="task-objective">${escapeHtml(task.objective)}</span>
    `;
    button.addEventListener("click", () => {
      state.activeTask = task;
      renderTasks();
      renderActiveTask();
      renderSignals();
      renderUploadPrompt();
    });
    els.taskList.appendChild(button);
  }
}

function renderActiveTask() {
  els.activeTitle.textContent = state.activeTask?.name || "No task selected";
  if (!state.activeTask) {
    els.activeTitle.textContent = "Create a collection task";
    els.activeTaskDetail.innerHTML = '<div class="empty-mini">Use Hermes Task Planner or fill Create Task manually. Upload unlocks after a task is created.</div>';
    return;
  }

  const task = state.activeTask;
  const rules = task.rules || {};
  const detailRows = [
    ["Media", task.mediaKind],
    ["Collection", task.collection],
    ["Must show", formatSignals(rules.semanticRequired)],
    ["Review if seen", formatSignals(rules.privacyReviewSignals)],
    ["Duration", durationRuleText(rules)],
    ["Resolution", resolutionRuleText(rules)]
  ];

  els.activeTaskDetail.innerHTML = `
    <p>${escapeHtml(task.objective)}</p>
    ${task.promptText ? `<p><strong>Prompt:</strong> ${escapeHtml(task.promptText)}</p>` : ""}
    <div class="task-detail-grid">
      ${detailRows
        .map(
          ([label, value]) => `
            <div>
              <span>${escapeHtml(label)}</span>
              <strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

async function createCustomTask(event) {
  event.preventDefault();
  const form = new FormData(els.customTaskForm);
  const payload = Object.fromEntries(form.entries());
  const data = await requestJson("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  state.tasks = data.tasks;
  state.activeTask = data.task;
  renderTasks();
  renderActiveTask();
  renderUploadPrompt();
  els.customTaskForm.reset();
  syncTaskFormForMedia();
  resetLiveConsole("Task ready", "Upload a matching media file, then run analysis.");
  setActiveView("analyze");
}

async function planTaskWithHermes() {
  const description = els.taskPlanInput.value.trim();
  if (!description) {
    els.taskPlanStatus.textContent = "Describe the dataset request first.";
    return;
  }

  els.taskPlanButton.disabled = true;
  els.taskPlanButton.textContent = "Planning";
  els.taskPlanStatus.textContent = "Hermes is converting the request into quality gates...";
  renderLiveRun([
    liveStep("active", "Hermes Task Planner", "Converting the dataset request into enforceable gates"),
    liveStep("pending", "Task schema", "Waiting for media type, signals, privacy flags, duration and resolution"),
    liveStep("pending", "UI handoff", "Prepared plan will populate Create Task")
  ]);

  try {
    const data = await requestJson("/api/hermes/plan-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description })
    });
    applyTaskPlan(data.plan);
    els.taskPlanStatus.textContent = "Hermes plan applied. Review and create the task.";
    completeLiveRun([
      "Hermes returned a structured collection task",
      "Quality gates applied to the Create Task form",
      "Task is ready for review and creation"
    ]);
  } catch (error) {
    els.taskPlanStatus.textContent = error.message;
    failLiveRun("Hermes task planning failed", error.message);
  } finally {
    els.taskPlanButton.disabled = false;
    els.taskPlanButton.textContent = "Plan Task";
  }
}

function applyTaskPlan(plan) {
  const form = els.customTaskForm.elements;
  setField(form.name, plan.name);
  setField(form.mediaKind, plan.mediaKind);
  setField(form.objective, plan.objective);
  setField(form.requiredSignals, listToCsv(plan.requiredSignals));
  setField(form.privacySignals, listToCsv(plan.privacySignals));
  setField(form.minDurationSec, plan.minDurationSec ?? "");
  setField(form.maxDurationSec, plan.maxDurationSec ?? "");
  setField(form.minWidth, plan.minWidth ?? "");
  setField(form.minHeight, plan.minHeight ?? "");
  setField(form.promptText, plan.promptText || "");
  syncTaskFormForMedia();
}

function syncTaskFormForMedia() {
  const form = els.customTaskForm.elements;
  const kind = form.mediaKind.value;
  els.spokenPromptField.classList.toggle("hidden", kind !== "audio");
  if (kind !== "audio") form.promptText.value = "";
}

function setField(field, value) {
  if (field) field.value = value;
}

function listToCsv(value) {
  return Array.isArray(value) ? value.join(",") : String(value || "");
}

async function selectFile(file) {
  setActiveView("analyze");
  state.selectedFile = file;
  state.metrics = null;
  state.evidence = null;
  els.analyzeButton.disabled = true;
  els.fileMeta.textContent = `${file.name} / ${formatBytes(file.size)}`;

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  renderPreview(file, state.objectUrl);

  els.signalPanel.innerHTML = '<div class="signal"><span>Status</span><strong>Extracting metrics</strong></div>';
  try {
    const extracted = await extractMetrics(file, state.objectUrl);
    state.metrics = extracted.metrics;
    state.evidence = extracted.evidence;
    renderSignals();
    resetLiveConsole("Submission ready", "Metrics and browser evidence are prepared. Start analysis to run models and Hermes.");
    els.analyzeButton.disabled = false;
  } catch (error) {
    els.signalPanel.innerHTML = `<div class="signal"><span>Error</span><strong>${escapeHtml(error.message)}</strong></div>`;
  }
}

function renderUploadPrompt() {
  const kind = state.activeTask?.mediaKind || "media";
  const accept = {
    image: "image/*",
    video: "video/*",
    audio: "audio/*"
  }[kind] || "image/*,video/*,audio/*";
  const title = {
    image: "Upload image file",
    video: "Upload video file",
    audio: "Upload audio file"
  }[kind] || "Select media file";
  const meta = {
    image: "Expected: JPG, PNG, WEBP, or HEIC image",
    video: "Expected: MP4, MOV, WEBM, or other video file",
    audio: "Expected: WAV, MP3, M4A, or WEBM audio"
  }[kind] || "Image, video, or audio";

  els.fileInput.setAttribute("accept", accept);
  els.fileInput.disabled = !state.activeTask;
  els.dropZone.classList.toggle("disabled", !state.activeTask);
  els.analyzeButton.disabled = !state.activeTask || !state.metrics;
  if (!state.selectedFile) {
    els.dropTitle.textContent = state.activeTask ? title : "Create a task first";
    els.fileMeta.textContent = state.activeTask ? meta : "Hermes needs a collection task before analysis";
  }
}

function renderPreview(file, url) {
  els.preview.className = "preview";
  if (file.type.startsWith("image/")) {
    els.preview.innerHTML = `<img src="${url}" alt="Selected submission preview" />`;
  } else if (file.type.startsWith("video/")) {
    els.preview.innerHTML = `<video src="${url}" controls muted playsinline></video>`;
  } else if (file.type.startsWith("audio/")) {
    els.preview.innerHTML = `<audio src="${url}" controls></audio>`;
  } else {
    els.preview.classList.add("empty");
    els.preview.innerHTML = "<span>Unsupported file type</span>";
  }
}

function renderSignals() {
  if (!state.metrics) {
    els.signalPanel.innerHTML = "";
    return;
  }

  const rows = state.metrics.kind === "audio"
    ? [
        ["Media", "audio"],
        ["Duration", secondsText(state.metrics.durationSec)],
        ["Voice level", audioLevelText(state.metrics.rms)],
        ["Quiet sections", silenceText(state.metrics.silenceRatio)]
      ]
    : [
        ["Media", state.metrics.kind],
        ["Resolution", dimensionText(state.metrics)],
        ["Duration", secondsText(state.metrics.durationSec)],
        ["Lighting", lightingText(state.metrics.brightness)]
      ];

  els.signalPanel.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="signal">
          <span>${escapeHtml(label)}</span>
          <strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong>
        </div>
      `
    )
    .join("");
}

async function analyzeCurrentFile() {
  if (!state.selectedFile || !state.metrics || !state.activeTask) return;
  setActiveView("analyze");
  els.analyzeButton.disabled = true;
  els.analyzeButton.textContent = "Analyzing";
  startLiveAnalysisRun(state.activeTask, state.metrics);

  const payload = {
    taskId: state.activeTask.id,
    file: {
      name: state.selectedFile.name,
      type: state.selectedFile.type,
      size: state.selectedFile.size,
      lastModified: state.selectedFile.lastModified
    },
    metrics: state.metrics,
    evidence: state.evidence || {},
    reviewerSignals: collectReviewerSignals()
  };

  try {
    const data = await requestJson("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderVerdict(data.submission);
    await refreshSubmissions();
  } catch (error) {
    failLiveRun("Analysis failed", error.message);
    throw error;
  } finally {
    els.analyzeButton.disabled = false;
    els.analyzeButton.textContent = "Analyze";
  }
}

function collectReviewerSignals() {
  return {
    semantic: {},
    privacy: {}
  };
}

function renderVerdict(submission) {
  stopLiveTimer();
  els.timeline.classList.remove("live");
  setLiveBadge(submission.verdict === "rejected" ? "fail" : submission.verdict === "needs_review" ? "active" : "done", submission.verdict.replace("_", " "));
  els.verdictBadge.className = `badge ${submission.verdict}`;
  els.verdictBadge.textContent = submission.verdict.replace("_", " ");
  els.scoreValue.textContent = submission.score;
  els.summaryTitle.textContent = submission.file.name;
  els.summaryText.textContent = submission.summary;

  renderDecisionMatrix(submission);
  renderHermesReview(submission.hermesReview);
  renderEvidencePack(submission);
  els.checks.innerHTML = submission.checks
    .filter((check) => !["Sharpness", "Privacy risk"].includes(check.label))
    .map(
      (check) => `
        <div class="check-row">
          <div>
            <strong>${escapeHtml(check.label)}</strong>
            <span>${escapeHtml(check.detail)}</span>
          </div>
          <div class="check-status ${check.status}">${escapeHtml(check.status)}</div>
        </div>
      `
    )
    .join("");

  renderModelSignals(submission.modelSignals);

  els.timeline.innerHTML = submission.timeline
    .map(simplifyTimelineItem)
    .filter(Boolean)
    .map((item) => `<li class="done">${escapeHtml(item)}</li>`)
    .join("");

  renderCompletedConsole(submission);
}

function startLiveAnalysisRun(task, metrics) {
  const visual = metrics.kind === "image" || metrics.kind === "video";
  const audio = metrics.kind === "audio";
  const visualReference = metrics.kind === "video"
    ? "overview contact sheet + segment contact sheets"
    : "sample image frame";
  const audioReference = "16 kHz mono WAV evidence for ASR";
  const steps = [
    liveStep(
      "done",
      visual ? "Browser frame sampler" : audio ? "Browser audio pack" : "Browser evidence pack",
      visual
        ? `Prepared ${visualReference}, media metrics, and perceptual hash`
        : audio
          ? `Decoded waveform, measured level/silence, and prepared ${audioReference}`
          : "Media metrics and hash prepared",
      visual ? `evidence.reference=${visualReference}` : audio ? "evidence.asrAudioDataUrl=ready" : ""
    ),
    liveStep(
      "active",
      "Deterministic gates",
      "Checking media type, duration, resolution/audio level, exposure, and duplicates",
      `task=${task.id} media=${metrics.kind}`
    ),
    ...(visual
      ? [
          liveStep(
            "pending",
            "Task-agnostic vision",
            "Bitdeer VLM describes what is actually visible before seeing task labels",
            "model=nemotron-nano-12b-v2-vl via Bitdeer"
          ),
          liveStep(
            "pending",
            "Vision compliance",
            "Required task signals are checked against sampled frames and segment references",
            "model=nemotron-nano-12b-v2-vl task-aware pass"
          )
        ]
      : []),
    ...(audio
      ? [
          liveStep(
            "pending",
            "NVIDIA Parakeet ASR",
            "Transcribing the uploaded voice sample",
            "model=parakeet-tdt-0.6b-v2"
          ),
          liveStep(
            "pending",
            "Prompt matcher",
            "Comparing transcript to the exact sentence configured by Hermes",
            task.promptText ? `expected="${task.promptText}"` : "expected=task prompt"
          )
        ]
      : []),
    liveStep(
      "pending",
      "NVIDIA policy layer",
      "Safety, PII, and policy reasoning are attached when configured",
      "providers=content-safety, gliner-pii, policy-reasoning"
    ),
    liveStep(
      "pending",
      "Hermes Data Quality Gate",
      "Hermes reads checks, model notes, transcript, and task signals, then writes the reviewer brief",
      "skill=data-quality-gate role=review_orchestrator"
    ),
    liveStep(
      "pending",
      "Final route",
      `Routing ${task.name} to accept, reject, or human review`,
      "decision=technical gates + semantic evidence + Hermes routing"
    )
  ];

  renderLiveRun(steps);
  advanceLiveRun(steps);
}

function liveStep(status, title, detail, meta = "") {
  return { status, title, detail, meta };
}

function renderLiveRun(steps) {
  stopLiveTimer();
  state.runStartedAt = Date.now();
  setLiveBadge("active", "Running");
  paintLiveSteps(steps);
}

function advanceLiveRun(steps) {
  let index = Math.max(0, steps.findIndex((step) => step.status === "active"));
  if (index === -1) index = 0;

  state.runTimer = window.setInterval(() => {
    const elapsed = Math.round((Date.now() - state.runStartedAt) / 1000);
    const currentItems = [...steps];
    const activeIndex = Math.min(index, currentItems.length - 1);
    for (let i = 0; i < currentItems.length; i += 1) {
      if (i < activeIndex) currentItems[i] = { ...currentItems[i], status: "done" };
      if (i === activeIndex) currentItems[i] = { ...currentItems[i], status: "active", elapsed };
      if (i > activeIndex) currentItems[i] = { ...currentItems[i], status: "pending" };
    }
    paintLiveSteps(currentItems);
    if (index < currentItems.length - 1) index += 1;
  }, 1700);
}

function completeLiveRun(items) {
  stopLiveTimer();
  setLiveBadge("done", "Done");
  paintLiveSteps(items.map((item) => liveStep("done", item, "Completed")));
}

function failLiveRun(title, detail) {
  stopLiveTimer();
  setLiveBadge("fail", "Failed");
  paintLiveSteps([liveStep("fail", title, detail || "The run could not complete")]);
}

function stopLiveTimer() {
  if (state.runTimer) window.clearInterval(state.runTimer);
  state.runTimer = null;
}

function paintLiveSteps(steps) {
  const html = steps.map(renderLiveStep).join("");
  if (els.liveConsole) {
    els.liveConsole.classList.add("live");
    els.liveConsole.innerHTML = html;
  }
}

function setLiveBadge(status, label) {
  if (!els.liveBadge) return;
  els.liveBadge.className = `badge ${status}`;
  els.liveBadge.textContent = label;
}

function resetLiveConsole(title = "Waiting for analysis", detail = "Upload media and run the active collection task.") {
  setLiveBadge("neutral", "Idle");
  paintLiveSteps([liveStep("pending", title, detail)]);
}

function renderCompletedConsole(submission) {
  const audio = submission.metrics.kind === "audio";
  const visual = submission.metrics.kind === "image" || submission.metrics.kind === "video";
  const semanticEntries = Object.entries(submission.modelSignals?.semantic || {});
  const passed = semanticEntries.filter(([, value]) => value === true).length;
  const notes = Array.isArray(submission.modelSignals?.notes)
    ? submission.modelSignals.notes.slice(0, 3).join(" | ")
    : "";
  const transcript = submission.modelSignals?.transcript
    ? `transcript="${truncateUi(submission.modelSignals.transcript, 120)}"`
    : "";
  const action = submission.hermesReview?.recommendedAction || submission.verdict;
  const steps = [
    liveStep(
      "done",
      visual ? "Evidence references captured" : audio ? "Audio evidence captured" : "Evidence captured",
      visual
        ? "The same contact sheets shown below were sent to the vision model."
        : audio
          ? "The uploaded audio was normalized for ASR and retained for audit."
          : "The evidence pack is attached to the result.",
      visual ? "reference=overview + segment sheets" : transcript
    ),
    ...(audio
      ? [
          liveStep(
            "done",
            "NVIDIA Parakeet ASR",
            submission.modelSignals?.transcript ? "Transcript returned and compared to the task prompt." : "ASR did not return a transcript.",
            transcript || "transcript=unavailable"
          )
        ]
      : []),
    liveStep(
      "done",
      visual ? "Visual/task signals" : "Prompt/task signals",
      semanticEntries.length
        ? `${passed}/${semanticEntries.length} configured task signals matched.`
        : "No semantic model signals were attached.",
      notes ? `model_notes=${truncateUi(notes, 180)}` : ""
    ),
    liveStep(
      submission.hermesReview?.ok ? "done" : "fail",
      "Hermes Data Quality Gate",
      submission.hermesReview?.routingReason || "Hermes generated the reviewer-facing route from the evidence package.",
      `action=${action} score=${submission.score}`
    ),
    liveStep(
      submission.verdict === "rejected" ? "fail" : submission.verdict === "needs_review" ? "active" : "done",
      "Final route",
      submission.summary,
      `verdict=${submission.verdict} confidence=${Math.round((submission.confidence || 0) * 100)}%`
    )
  ];
  paintLiveSteps(steps);
}

function renderLiveStep(step) {
  const elapsed = typeof step.elapsed === "number" ? ` - ${step.elapsed}s` : "";
  const meta = step.meta ? `<code>${escapeHtml(step.meta)}</code>` : "";
  return `
    <li class="${escapeHtml(step.status)}">
      <strong>${escapeHtml(step.title)}${elapsed}</strong>
      <span>${escapeHtml(step.detail)}</span>
      ${meta}
    </li>
  `;
}

function renderHermesReview(review) {
  if (!review) {
    els.hermesReview.innerHTML = "";
    return;
  }

  const checklist = Array.isArray(review.reviewChecklist) ? review.reviewChecklist : [];
  els.hermesReview.innerHTML = `
    <article class="hermes-card ${review.ok ? "" : "warning"}">
      <div class="hermes-card-head">
        <span>Hermes Review</span>
        <strong>${escapeHtml(actionLabel(review.recommendedAction))}</strong>
      </div>
      <h3>${escapeHtml(review.headline || "Hermes review completed")}</h3>
      <p>${escapeHtml(review.reviewBrief || "")}</p>
      ${review.contributorFeedback ? `<p class="contributor-note">${escapeHtml(review.contributorFeedback)}</p>` : ""}
      ${checklist.length ? `
        <ul>
          ${checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      ` : ""}
    </article>
  `;
}

function renderDecisionMatrix(submission) {
  const blockers = submission.blockers?.length || 0;
  const reviewReasons = submission.reviewReasons?.length || 0;
  const confidence = Math.round((submission.confidence || 0) * 100);
  const status = blockers > 0 ? "fail" : reviewReasons > 0 ? "review" : "pass";
  const taskSignals = Object.values(submission.modelSignals?.semantic || {});
  const taskMatches = taskSignals.filter(Boolean).length;
  const taskMatchText = taskSignals.length ? `${taskMatches}/${taskSignals.length}` : "pending";
  const taskMatchClass = !taskSignals.length
    ? "review"
    : taskMatches === taskSignals.length
      ? "pass"
      : taskMatches === 0
        ? "fail"
        : "review";

  els.decisionMatrix.innerHTML = `
    <div class="matrix-grid">
      <div class="matrix-cell ${status}">
        <span>Blocking issues</span>
        <strong>${blockers}</strong>
      </div>
      <div class="matrix-cell ${reviewReasons ? "review" : "pass"}">
        <span>Review items</span>
        <strong>${reviewReasons}</strong>
      </div>
      <div class="matrix-cell ${taskMatchClass}">
        <span>Task match</span>
        <strong>${taskMatchText}</strong>
      </div>
      <div class="matrix-cell ${confidence >= 80 ? "pass" : confidence >= 55 ? "review" : "fail"}">
        <span>Confidence</span>
        <strong>${confidence}%</strong>
      </div>
    </div>
  `;
}

function renderEvidencePack(submission) {
  const evidence = state.evidence || {};
  const thumbnail = evidence.sampleImageDataUrl
    ? `<img src="${evidence.sampleImageDataUrl}" alt="Sampled evidence frame" />`
    : `<span>${submission.metrics.kind === "audio" ? "Audio evidence attached" : "No sampled frame"}</span>`;
  const segments = Array.isArray(evidence.segmentImageDataUrls)
    ? evidence.segmentImageDataUrls.slice(0, 3)
    : [];

  const meta = [
    ["Task", submission.task.name],
    ["Media", `${submission.metrics.kind} / ${formatBytes(submission.file.size)}`],
    ["Resolution", dimensionText(submission.metrics)],
    ["Duration", secondsText(submission.metrics.durationSec)]
  ];

  els.evidencePack.innerHTML = `
    <div class="evidence-layout">
      <div class="evidence-thumb">${thumbnail}</div>
      <div class="evidence-meta">
        ${meta
          .map(
            ([label, value]) => `
              <div>
                <span>${escapeHtml(label)}</span>
                <strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong>
              </div>
            `
          )
          .join("")}
      </div>
      ${segments.length ? `
        <div class="evidence-segments">
          ${segments
            .map(
              (segment) => `
                <figure>
                  <img src="${segment.imageDataUrl}" alt="${escapeHtml(segment.label)} evidence" />
                  <figcaption>${escapeHtml(segment.label)}</figcaption>
                </figure>
              `
            )
            .join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderModelSignals(signals) {
  const semantic = Object.entries(signals?.semantic || {});
  const notes = Array.isArray(signals?.notes) ? signals.notes.slice(0, 5) : [];
  const transcript = signals?.transcript ? String(signals.transcript) : "";
  if (!semantic.length && !notes.length && !transcript) {
    els.modelSignals.innerHTML = "";
    return;
  }

  els.modelSignals.innerHTML = [
    semantic.length ? signalGroup("Task Match", semantic) : "",
    transcript ? notesGroup("ASR Transcript", [transcript]) : "",
    notes.length ? notesGroup("Model Observations", notes) : ""
  ].join("");
}

function signalGroup(title, entries) {
  return `
    <section class="signal-group">
      <h3>${escapeHtml(title)}</h3>
      <div class="signal-chips">
        ${entries
          .map(([key, value]) => `<span class="signal-chip ${signalChipClass(value)}">${escapeHtml(key)} ${signalChipLabel(value)}</span>`)
          .join("")}
      </div>
    </section>
  `;
}

function signalChipClass(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "review";
}

function signalChipLabel(value) {
  if (value === true) return "met";
  if (value === false) return "missing";
  return "needs review";
}

function notesGroup(title, notes) {
  return `
    <section class="signal-group">
      <h3>${escapeHtml(title)}</h3>
      <ul class="signal-notes">
        ${notes.map((note) => `<li>${escapeHtml(truncateUi(note, 220))}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderSummary(summary) {
  return summary;
}

function renderReviewQueue() {
  const open = state.submissions.filter((submission) => submission.reviewStatus === "open");
  if (open.length === 0) {
    const recent = state.submissions.slice(0, 3);
    if (recent.length === 0) {
      els.reviewQueue.innerHTML = '<div class="empty-state">No submissions waiting for review</div>';
      return;
    }
    els.reviewQueue.innerHTML = recent
      .map(
        (submission) => `
          <article class="review-card closed">
            <button class="queue-remove" type="button" title="Remove result" aria-label="Remove result" data-remove-submission="${escapeHtml(submission.id)}">&times;</button>
            <div>
              <h3>${escapeHtml(submission.file.name)}</h3>
              <p>${escapeHtml(submission.summary)}</p>
            </div>
            <div class="review-meta">
              <span>${escapeHtml(submission.verdict.replace("_", " "))}</span>
              <span>score ${submission.score}</span>
            </div>
          </article>
        `
      )
      .join("");
    bindQueueRemoveButtons();
    return;
  }

  els.reviewQueue.innerHTML = "";
  for (const submission of open) {
    const card = document.createElement("article");
    card.className = "review-card";
    const reasons = submission.reviewReasons || [];
    card.innerHTML = `
      <button class="queue-remove" type="button" title="Remove result" aria-label="Remove result" data-remove-submission="${escapeHtml(submission.id)}">&times;</button>
      <div>
        <h3>${escapeHtml(submission.file.name)}</h3>
        <p>${escapeHtml(submission.summary)}</p>
      </div>
      <div class="review-meta">
        <span>score ${submission.score}</span>
        <span>${escapeHtml(submission.metrics.kind)}</span>
      </div>
      <p>${escapeHtml(reasons.join(" / ") || "Reviewer judgement required")}</p>
      <div class="review-actions">
        <button data-decision="accepted">Accept</button>
        <button class="secondary" data-decision="needs_more_evidence">More Evidence</button>
        <button class="reject" data-decision="rejected">Reject</button>
      </div>
    `;
    card.querySelectorAll("[data-decision]").forEach((button) => {
      button.addEventListener("click", () => reviewSubmission(submission.id, button.dataset.decision));
    });
    card.querySelector("[data-remove-submission]").addEventListener("click", () => deleteSubmission(submission.id));
    els.reviewQueue.appendChild(card);
  }
}

function bindQueueRemoveButtons() {
  els.reviewQueue.querySelectorAll("[data-remove-submission]").forEach((button) => {
    button.addEventListener("click", () => deleteSubmission(button.dataset.removeSubmission));
  });
}

async function reviewSubmission(id, decision) {
  await requestJson(`/api/submissions/${id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, reviewer: "demo-reviewer" })
  });
  await refreshSubmissions();
}

async function deleteSubmission(id) {
  await requestJson(`/api/submissions/${id}`, { method: "DELETE" });
  state.submissions = state.submissions.filter((submission) => submission.id !== id);
  await refreshSubmissions();
}

async function extractMetrics(file, url) {
  const kind = mediaKind(file.type);
  if (kind === "image") return extractImageMetrics(file, url);
  if (kind === "video") return extractVideoMetrics(file, url);
  if (kind === "audio") return extractAudioMetrics(file);
  throw new Error("Unsupported media type");
}

function mediaKind(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "unknown";
}

async function extractImageMetrics(file, url) {
  const image = await loadImage(url);
  const canvas = fitCanvas(image.naturalWidth, image.naturalHeight, 480);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const quality = analyzeImageData(data);

  return {
    metrics: {
      kind: "image",
      mime: file.type,
      width: image.naturalWidth,
      height: image.naturalHeight,
      durationSec: null,
      blurScore: quality.blurScore,
      brightness: quality.brightness,
      perceptualHash: makeDHash(ctx, canvas.width, canvas.height)
    },
    evidence: {
      sampleImageDataUrl: canvas.toDataURL("image/jpeg", 0.72)
    }
  };
}

async function extractVideoMetrics(file, url) {
  const video = await loadVideo(url);
  const sampleTimes = [0.06, 0.14, 0.23, 0.32, 0.41, 0.5, 0.59, 0.68, 0.77, 0.86, 0.94].map((ratio) =>
    Math.max(0.1, video.duration * ratio)
  );
  const frameStats = [];
  const frames = [];
  let previous = null;
  let motionTotal = 0;
  let hash = "";

  for (const time of sampleTimes) {
    await seekVideo(video, Math.min(time, Math.max(0.1, video.duration - 0.1)));
    const canvas = fitCanvas(video.videoWidth, video.videoHeight, 360);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    frameStats.push(analyzeImageData(imageData));
    frames.push({ canvas, time });
    if (!hash) hash = makeDHash(ctx, canvas.width, canvas.height);
    if (previous) motionTotal += frameDifference(previous, imageData);
    previous = imageData;
  }

  const evidenceCanvas = makeVideoContactSheet(frames);
  const segmentSheets = makeSegmentContactSheets(frames, 3);

  return {
    metrics: {
      kind: "video",
      mime: file.type,
      width: video.videoWidth,
      height: video.videoHeight,
      durationSec: video.duration,
      blurScore: average(frameStats.map((item) => item.blurScore)),
      brightness: average(frameStats.map((item) => item.brightness)),
      motionScore: motionTotal / Math.max(1, frameStats.length - 1),
      perceptualHash: hash
    },
    evidence: {
      sampleImageDataUrl: evidenceCanvas.toDataURL("image/jpeg", 0.76),
      segmentImageDataUrls: segmentSheets.map((segment) => ({
        label: segment.label,
        imageDataUrl: segment.canvas.toDataURL("image/jpeg", 0.76)
      })),
      sampleTimes: frames.map((frame) => Number(frame.time.toFixed(2)))
    }
  };
}

function makeSegmentContactSheets(frames, segmentCount) {
  const usableFrames = frames.filter(Boolean);
  if (usableFrames.length === 0) return [];
  const perSegment = Math.ceil(usableFrames.length / segmentCount);
  const segments = [];

  for (let index = 0; index < segmentCount; index += 1) {
    const segmentFrames = usableFrames.slice(index * perSegment, (index + 1) * perSegment);
    if (segmentFrames.length === 0) continue;
    segments.push({
      label: `video segment ${index + 1}`,
      canvas: makeVideoContactSheet(segmentFrames, `segment ${index + 1}`)
    });
  }

  return segments;
}

function makeVideoContactSheet(frames, title = "") {
  const usableFrames = frames.filter(Boolean);
  const width = Math.max(...usableFrames.map((frame) => frame.canvas.width), 1);
  const height = Math.max(...usableFrames.map((frame) => frame.canvas.height), 1);
  const gutter = 12;
  const titleHeight = title ? 28 : 0;
  const labelHeight = 24;
  const columns = Math.min(4, usableFrames.length);
  const rows = Math.ceil(usableFrames.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = columns * width + Math.max(0, columns - 1) * gutter;
  canvas.height = titleHeight + rows * (height + labelHeight) + Math.max(0, rows - 1) * gutter;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111820";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillStyle = "#ffffff";

  if (title) {
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillText(title, 10, 19);
    ctx.font = "14px system-ui, sans-serif";
  }

  usableFrames.forEach((frame, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * (width + gutter);
    const y = titleHeight + row * (height + labelHeight + gutter);
    ctx.drawImage(frame.canvas, x, y + labelHeight, width, height);
    ctx.fillText(`frame ${index + 1} / ${frame.time.toFixed(1)}s`, x + 8, y + 17);
  });

  return canvas;
}

async function extractAudioMetrics(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const channel = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(channel.length / 60000));
  let sumSquares = 0;
  let count = 0;
  let silent = 0;

  for (let i = 0; i < channel.length; i += step) {
    const value = channel[i];
    sumSquares += value * value;
    if (Math.abs(value) < 0.012) silent += 1;
    count += 1;
  }

  await audioContext.close();

  return {
    metrics: {
      kind: "audio",
      mime: file.type,
      width: null,
      height: null,
      durationSec: buffer.duration,
      rms: Math.sqrt(sumSquares / Math.max(1, count)),
      silenceRatio: silent / Math.max(1, count),
      perceptualHash: audioFingerprint(channel, step)
    },
    evidence: {
      asrAudioDataUrl: audioBufferToWavDataUrl(buffer, 16000)
    }
  };
}

function audioBufferToWavDataUrl(buffer, targetSampleRate) {
  const mono = mixToMono(buffer);
  const resampled = resampleLinear(mono, buffer.sampleRate, targetSampleRate);
  const wav = encodeWav16Mono(resampled, targetSampleRate);
  return `data:audio/wav;base64,${uint8ToBase64(wav)}`;
}

function mixToMono(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const output = new Float32Array(length);
  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const input = buffer.getChannelData(channelIndex);
    for (let i = 0; i < length; i += 1) output[i] += input[i] / channels;
  }
  return output;
}

function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const sourceIndex = i * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(input.length - 1, low + 1);
    const weight = sourceIndex - low;
    output[i] = input[low] * (1 - weight) + input[high] * weight;
  }
  return output;
}

function encodeWav16Mono(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be decoded"));
    image.src = url;
  });
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error("Video could not be decoded"));
    video.src = url;
  });
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    video.onseeked = () => resolve();
    video.currentTime = time;
  });
}

function fitCanvas(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

function analyzeImageData(imageData) {
  const { data, width, height } = imageData;
  let brightness = 0;
  let samples = 0;
  let gradient = 0;

  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      const i = (y * width + x) * 4;
      const gray = luminance(data[i], data[i + 1], data[i + 2]);
      const right = ((y * width + (x + 1)) * 4);
      const down = (((y + 1) * width + x) * 4);
      const gx = gray - luminance(data[right], data[right + 1], data[right + 2]);
      const gy = gray - luminance(data[down], data[down + 1], data[down + 2]);
      brightness += gray;
      gradient += Math.sqrt(gx * gx + gy * gy);
      samples += 1;
    }
  }

  return {
    brightness: Math.round((brightness / Math.max(1, samples) / 255) * 100),
    blurScore: Math.round((gradient / Math.max(1, samples)) * 10) / 10
  };
}

function frameDifference(left, right) {
  const a = left.data;
  const b = right.data;
  const length = Math.min(a.length, b.length);
  let diff = 0;
  let count = 0;
  for (let i = 0; i < length; i += 48) {
    diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 1;
  }
  return Math.round((diff / Math.max(1, count) / 255) * 100);
}

function makeDHash(sourceContext, sourceWidth, sourceHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = 9;
  canvas.height = 8;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceContext.canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;
  let bits = "";

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = pixelGray(data, y * 9 + x);
      const right = pixelGray(data, y * 9 + x + 1);
      bits += left > right ? "1" : "0";
    }
  }

  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

function audioFingerprint(channel, step) {
  const bucketCount = 16;
  const buckets = new Array(bucketCount).fill(0);
  const counts = new Array(bucketCount).fill(0);
  for (let i = 0; i < channel.length; i += step) {
    const bucket = Math.min(bucketCount - 1, Math.floor((i / channel.length) * bucketCount));
    buckets[bucket] += Math.abs(channel[i]);
    counts[bucket] += 1;
  }
  return buckets
    .map((value, index) => Math.min(15, Math.round((value / Math.max(1, counts[index])) * 80)))
    .map((value) => value.toString(16))
    .join("")
    .padEnd(16, "0");
}

function pixelGray(data, pixelIndex) {
  const i = pixelIndex * 4;
  return luminance(data[i], data[i + 1], data[i + 2]);
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function average(values) {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)) * 100) / 100;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function dimensionText(metrics) {
  if (!metrics.width || !metrics.height) return "n/a";
  return `${metrics.width} x ${metrics.height}`;
}

function secondsText(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(2)} sec`;
}

function sharpnessText(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not checked";
  if (value >= 18) return "Sharp";
  if (value >= 12) return "Review";
  return "Too blurry";
}

function lightingText(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not checked";
  if (value >= 20 && value <= 86) return "Balanced";
  if (value >= 14 && value <= 92) return "Review";
  return "Poor";
}

function audioLevelText(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not checked";
  if (value >= 0.02) return "Clear";
  if (value >= 0.012) return "Review";
  return "Too quiet";
}

function silenceText(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "Not checked";
  if (value <= 0.38) return "Good";
  if (value <= 0.55) return "Review";
  return "Too much silence";
}

function actionLabel(value) {
  const labels = {
    accept: "Accept",
    reject: "Reject",
    send_to_human_review: "Human review",
    request_more_evidence: "More evidence"
  };
  return labels[value] || "Review";
}

function simplifyTimelineItem(item) {
  if (item === "Parsed task requirements") return "Task requirements read";
  if (item.startsWith("Classified media as")) return "Media type checked";
  if (item === "Ran deterministic media checks") return "Quality rules evaluated";
  if (item === "Ran task-agnostic visual observation") return "Bitdeer described visible scene";
  if (item === "Ran vision task compliance") return "Vision task signals checked";
  if (item === "Ran NVIDIA Parakeet ASR") return "NVIDIA Parakeet transcribed audio";
  if (item === "Ran NVIDIA content safety") return "NVIDIA content safety checked";
  if (item === "Ran NVIDIA PII scan") return "NVIDIA PII scan checked";
  if (item === "Ran NVIDIA policy reasoning") return "NVIDIA policy reasoning attached";
  if (item === "Built evidence pack") return "Review evidence prepared";
  if (item === "Applied model-derived task signals") return "Task match evaluated";
  if (item === "Attached model evidence") return null;
  if (item === "Hermes generated reviewer brief") return "Hermes prepared reviewer guidance";
  if (item === "Hermes review unavailable") return "Hermes review unavailable";
  if (item === "Routed to human review") return "Sent to human review";
  if (item === "Cleared for dataset ingestion") return "Cleared for dataset intake";
  if (item === "Rejected with auditable hard-failure evidence") return "Rejected with clear reasons";
  return item;
}

function formatSignals(values) {
  if (!values || values.length === 0) return "none";
  return values.join(", ");
}

function durationRuleText(rules) {
  if (typeof rules.minDurationSec !== "number" && typeof rules.maxDurationSec !== "number") return "n/a";
  return `${rules.minDurationSec ?? 0}-${rules.maxDurationSec ?? "n/a"} sec`;
}

function resolutionRuleText(rules) {
  if (!rules.minWidth && !rules.minHeight) return "n/a";
  return `${rules.minWidth || 0} x ${rules.minHeight || 0}+`;
}

function truncateUi(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
