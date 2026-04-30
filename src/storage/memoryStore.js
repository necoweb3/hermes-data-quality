const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

class MemoryStore {
  constructor(tasks, options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), "data", "store.json");
    this.tasks = [];
    this.submissions = [];

    const saved = this.read();
    this.tasks = Array.isArray(saved.tasks)
      ? saved.tasks
      : tasks.map((task) => ({ ...task, rules: { ...task.rules }, thresholds: { ...task.thresholds } }));
    this.submissions = Array.isArray(saved.submissions) ? saved.submissions : [];
  }

  listTasks() {
    return this.tasks;
  }

  getTask(taskId) {
    return this.tasks.find((task) => task.id === taskId) || this.tasks[0];
  }

  addTask(task) {
    this.tasks.unshift(task);
    this.write();
    return task;
  }

  listSubmissions() {
    return [...this.submissions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  addSubmission(payload) {
    const submission = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      reviewStatus: payload.verdict === "needs_review" ? "open" : "closed",
      reviewerDecision: null,
      ...payload
    };
    this.submissions.push(submission);
    this.write();
    return submission;
  }

  updateReview(id, decision) {
    const item = this.submissions.find((submission) => submission.id === id);
    if (!item) return null;
    item.reviewStatus = "closed";
    item.reviewerDecision = {
      ...decision,
      decidedAt: new Date().toISOString()
    };
    this.write();
    return item;
  }

  deleteSubmission(id) {
    const index = this.submissions.findIndex((submission) => submission.id === id);
    if (index === -1) return null;
    const [removed] = this.submissions.splice(index, 1);
    this.write();
    return removed;
  }

  hashesForTask(taskId) {
    return this.submissions
      .filter((submission) => submission.task.id === taskId && submission.metrics.perceptualHash)
      .map((submission) => ({
        id: submission.id,
        fileName: submission.file.name,
        hash: submission.metrics.perceptualHash
      }));
  }

  summary() {
    const total = this.submissions.length;
    const counts = {
      accepted: 0,
      rejected: 0,
      needs_review: 0
    };
    for (const submission of this.submissions) {
      counts[submission.verdict] += 1;
    }
    return {
      total,
      counts,
      openReview: this.submissions.filter((submission) => submission.reviewStatus === "open").length
    };
  }

  read() {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return {};
    }
  }

  write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ tasks: this.tasks, submissions: this.submissions }, null, 2)
    );
  }
}

module.exports = { MemoryStore };
