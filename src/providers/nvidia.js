class NvidiaProvider {
  constructor(env = process.env) {
    this.baseUrl = env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
    this.defaultKey = env.NVIDIA_API_KEY || "";
    this.models = {
      safety: env.NVIDIA_SAFETY_MODEL || "nvidia/nemotron-3-content-safety",
      policy: env.NVIDIA_POLICY_MODEL || "nvidia/nemotron-content-safety-reasoning-4b",
      pii: env.NVIDIA_PII_MODEL || "nvidia/gliner-pii",
      asr: env.NVIDIA_ASR_MODEL || "nvidia/parakeet-tdt-0.6b-v2",
      nvclip: env.NVIDIA_NVCLIP_MODEL || "nvidia/nvclip",
      activeSpeaker: env.NVIDIA_ACTIVE_SPEAKER_MODEL || "nvidia/active-speaker-detection",
      vision: env.NVIDIA_VISION_MODEL || "",
      syntheticVideo: env.NVIDIA_SYNTHETIC_VIDEO_MODEL || ""
    };
    this.keys = {
      safety: env.NVIDIA_SAFETY_API_KEY || this.defaultKey,
      policy: env.NVIDIA_POLICY_API_KEY || this.defaultKey,
      pii: env.NVIDIA_PII_API_KEY || this.defaultKey,
      asr: env.NVIDIA_ASR_API_KEY || this.defaultKey,
      nvclip: env.NVIDIA_NVCLIP_API_KEY || this.defaultKey,
      activeSpeaker: env.NVIDIA_ACTIVE_SPEAKER_API_KEY || this.defaultKey,
      vision: env.NVIDIA_VISION_API_KEY || this.defaultKey,
      syntheticVideo: env.NVIDIA_SYNTHETIC_VIDEO_API_KEY || this.defaultKey
    };
  }

  enabled() {
    return Object.values(this.keys).some(Boolean);
  }

  isConfigured(kind) {
    return Boolean(this.models[kind] && this.keys[kind]);
  }

  describe() {
    return {
      enabled: this.enabled(),
      baseUrl: this.baseUrl,
      models: Object.fromEntries(
        Object.entries(this.models).map(([kind, model]) => [
          kind,
          {
            model: model || null,
            configured: this.isConfigured(kind)
          }
        ])
      )
    };
  }

  async explainVerdict({ task, metrics, verdict }) {
    if (!this.isConfigured("policy")) {
      return {
        enabled: false,
        note: "NVIDIA policy model is not configured. Deterministic checks were used."
      };
    }

    return {
      enabled: true,
      result: await this.chatCompletion("policy", [
        {
          role: "system",
          content:
            "You are a dataset quality reviewer. Return concise JSON with risk_notes and reviewer_next_step. /no_think"
        },
        {
          role: "user",
          content: JSON.stringify({ task, metrics, verdict })
        }
      ])
    };
  }

  async checkContentSafety({ text, imageDataUrl }) {
    if (!this.isConfigured("safety")) return unavailable("safety");
    const content = [];
    if (imageDataUrl) content.push({ type: "image_url", image_url: { url: imageDataUrl } });
    content.push({ type: "text", text: text || "Assess this dataset submission for safety." });

    return this.chatCompletion("safety", [{ role: "user", content }], {
      max_tokens: 256,
      temperature: 0,
      chat_template_kwargs: { request_categories: "/categories" }
    });
  }

  async detectPii(text, labels) {
    if (!this.isConfigured("pii")) return unavailable("pii");
    const body = {
      messages: [{ role: "user", content: text }],
      threshold: 0.35,
      flat_ner: true
    };
    if (Array.isArray(labels) && labels.length > 0) body.labels = labels;
    return this.invoke("pii", "/chat/completions", body);
  }

  async chatCompletion(kind, messages, options = {}) {
    return this.invoke(kind, "/chat/completions", {
      model: this.models[kind],
      messages,
      stream: false,
      ...options
    });
  }

  async invoke(kind, path, body) {
    const key = this.keys[kind];
    const model = this.models[kind];
    if (!key || !model) return unavailable(kind);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, ...body })
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
        kind,
        model,
        status: response.status,
        error: summarizeError(payload)
      };
    }

    return {
      ok: true,
      kind,
      model,
      status: response.status,
      payload
    };
  }
}

function unavailable(kind) {
  return {
    ok: false,
    kind,
    status: "not_configured",
    error: `${kind} model or API key is not configured`
  };
}

function summarizeError(payload) {
  if (!payload) return "Empty NVIDIA error response";
  if (typeof payload === "string") return payload.slice(0, 240);
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  return JSON.stringify(payload).slice(0, 240);
}

module.exports = { NvidiaProvider };
