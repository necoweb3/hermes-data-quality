class BitdeerProvider {
  constructor(env = process.env) {
    this.apiKey = env.BITDEER_API_KEY || "";
    this.baseUrl = env.BITDEER_BASE_URL || "https://api-inference.bitdeer.ai/v1";
    this.visionModel = env.BITDEER_VISION_MODEL || "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL";
  }

  enabled() {
    return Boolean(this.apiKey && this.visionModel);
  }

  describe() {
    return {
      enabled: this.enabled(),
      baseUrl: this.baseUrl,
      model: this.visionModel || null
    };
  }

  async listModels() {
    if (!this.apiKey) return unavailable("models");
    return this.request("/models", { method: "GET" });
  }

  async evaluateFrame({ task, metrics, imageDataUrl, contextLabel = "overview contact sheet" }) {
    if (!this.enabled()) return unavailable("vision");
    if (!imageDataUrl) return unavailable("sample_image");

    const prompt = [
      "You are a dataset quality reviewer for high-volume multimodal data intake.",
      "Assess whether this visual evidence supports the dataset collection task.",
      "For videos, the image may be a contact sheet of multiple sampled frames from the same clip.",
      `This evidence pass is: ${contextLabel}.`,
      "Use the full sequence to infer motion, POV perspective, visible limbs, and activity when reasonable.",
      "Evaluate the semantic meaning of each required signal, not only the literal snake_case label.",
      "For action-video tasks, treat running, walking, jumping, vaulting, climbing, landing, manipulating objects, using tools, moving over/around objects, or other task-specific motion as valid action/interaction when the frames support it.",
      "Return compact JSON only. Do not use markdown.",
      "Use this schema:",
      "{\"task_match_score\":0.0,\"wrong_subject_or_activity\":false,\"scene_summary\":\"\",\"visible_required_elements\":{},\"privacy_flags\":{},\"rejection_risks\":[],\"reviewer_next_step\":\"\"}",
      "task_match_score is the overall confidence that the submission matches the requested dataset task.",
      "Do not increase task_match_score because of resolution, duration, or general video quality. Technical quality is evaluated separately.",
      "If the evidence clearly shows a different subject or activity than requested, set task_match_score <= 0.25 and mark task-specific required signals false.",
      "Set wrong_subject_or_activity true only when the visible subject/activity is clearly unrelated to the requested collection.",
      "If wrong_subject_or_activity is true, do not give credit for generic video qualities like resolution, movement, or a camera angle.",
      "scene_summary must briefly describe what is actually visible in the evidence.",
      "Set each required signal key to true, false, or null. Use null for uncertainty.",
      "Set a visual/action signal to false when the sequence clearly contradicts it or the required subject/action is absent. If the sequence mostly matches the task, prefer true or null over false for granular labels.",
      "When a required signal is about movement, action, manipulation, interaction, or camera motion, judge it from frame-to-frame changes and the task context.",
      "Set privacy_flags keys to true only when visible or likely, otherwise return an empty object.",
      `Task: ${task.name}`,
      `Objective: ${task.objective}`,
      `Required signals: ${(task.rules.semanticRequired || []).join(", ")}`,
      `Privacy review signals: ${(task.rules.privacyReviewSignals || []).join(", ")}`,
      `Technical metrics: ${JSON.stringify(metrics)}`
    ].join("\n");

    return this.chatCompletion([
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ]);
  }

  async describeFrame({ metrics, imageDataUrl, contextLabel = "overview contact sheet" }) {
    if (!this.enabled()) return unavailable("vision_observation");
    if (!imageDataUrl) return unavailable("sample_image");

    const prompt = [
      "You are a task-agnostic visual observer for a dataset QA pipeline.",
      "Describe only what is visible in the image evidence. Do not infer a requested task because none is provided.",
      "For videos, the image may be a contact sheet of frames from one clip.",
      `This evidence pass is: ${contextLabel}.`,
      "Return compact JSON only. Do not use markdown.",
      "Use this schema:",
      "{\"scene_summary\":\"\",\"subjects\":[],\"actions\":[],\"objects\":[],\"environment\":\"\",\"camera_perspective\":\"\",\"visible_body_parts\":[],\"negative_observations\":[]}",
      "subjects should name visible subject categories such as person, animal, vehicle, shopping_cart, kitchen_sink.",
      "actions should name visible actions such as walking, running, jumping, washing, climbing, standing, static_camera.",
      "negative_observations should include important absent items only when obvious, such as no_person_visible, no_hands_visible, no_task_action_visible.",
      `Technical metrics: ${JSON.stringify(metrics)}`
    ].join("\n");

    return this.chatCompletion(
      [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }
      ],
      { max_tokens: 360 }
    );
  }

  async chatCompletion(messages, options = {}) {
    return this.request("/chat/completions", {
      method: "POST",
      body: {
        model: this.visionModel,
        messages,
        max_tokens: 420,
        temperature: 0,
        stream: false,
        ...options
      }
    });
  }

  async request(path, { method, body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: summarizeError(payload)
      };
    }

    return {
      ok: true,
      status: response.status,
      payload
    };
  }
}

function unavailable(kind) {
  return {
    ok: false,
    status: "not_configured",
    error: `${kind} is not configured`
  };
}

function summarizeError(payload) {
  if (!payload) return "Empty Bitdeer error response";
  if (typeof payload === "string") return payload.slice(0, 240);
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  return JSON.stringify(payload).slice(0, 240);
}

module.exports = { BitdeerProvider };
