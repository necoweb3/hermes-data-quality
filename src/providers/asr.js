const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

class AsrProvider {
  constructor(env = process.env) {
    this.apiKey = env.NVIDIA_ASR_API_KEY || env.NVIDIA_API_KEY || "";
    this.model = env.NVIDIA_ASR_MODEL || "nvidia/parakeet-tdt-0.6b-v2";
    this.functionId = env.NVIDIA_ASR_FUNCTION_ID || "d3fe9151-442b-4204-a70d-5fcc597fd610";
    this.runner = (env.ASR_RUNNER || "wsl").toLowerCase();
    this.wslDistro = env.ASR_WSL_DISTRO || "Ubuntu-22.04";
    this.server = env.ASR_SERVER || "grpc.nvcf.nvidia.com:443";
    this.languageCode = env.ASR_LANGUAGE_CODE || "en-US";
    this.timeoutMs = Number(env.ASR_TIMEOUT_MS || 120000);
    this.pythonCommand = env.ASR_PYTHON_COMMAND || "python";
  }

  enabled() {
    return Boolean(this.apiKey && this.functionId);
  }

  describe() {
    return {
      enabled: this.enabled(),
      model: this.model,
      runner: this.runner,
      server: this.server,
      languageCode: this.languageCode
    };
  }

  async transcribeDataUrl(dataUrl) {
    if (!this.enabled()) return unavailable("asr");
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      return {
        ok: false,
        status: "invalid_audio",
        error: "Audio evidence is not a valid data URL"
      };
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-asr-"));
    const audioPath = path.join(tempDir, `audio.${extensionForMime(parsed.mime)}`);
    await fs.writeFile(audioPath, parsed.bytes);

    try {
      const result = await this.runRivaClient(audioPath);
      return result;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  runRivaClient(audioPath) {
    const scriptPath = path.resolve(__dirname, "..", "..", "scripts", "riva_transcribe.py");
    const commonArgs = [
      "--input-file",
      audioPath,
      "--server",
      this.server,
      "--function-id",
      this.functionId,
      "--language-code",
      this.languageCode
    ];

    let command = this.pythonCommand;
    let args = [scriptPath, ...commonArgs];
    if (this.runner === "wsl") {
      command = "wsl.exe";
      args = [
        "-d",
        this.wslDistro,
        "--",
        "python3",
        windowsPathToWsl(scriptPath),
        "--input-file",
        windowsPathToWsl(audioPath),
        "--server",
        this.server,
        "--function-id",
        this.functionId,
        "--language-code",
        this.languageCode
      ];
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        windowsHide: true,
        env: {
          ...process.env,
          NVIDIA_API_KEY: this.apiKey,
          WSLENV:
            this.runner === "wsl"
              ? appendWslEnv(process.env.WSLENV, "NVIDIA_API_KEY")
              : process.env.WSLENV
        }
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve({
          ok: false,
          status: "timeout",
          error: `ASR timed out after ${this.timeoutMs}ms`
        });
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          status: "spawn_error",
          error: error.message
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({
            ok: false,
            status: "asr_error",
            error: cleanError(stderr || stdout || `ASR runner exited with ${code}`)
          });
          return;
        }
        try {
          const payload = JSON.parse(stdout.trim());
          resolve({
            ok: true,
            status: 200,
            payload
          });
        } catch {
          resolve({
            ok: false,
            status: "parse_error",
            error: cleanError(stdout || stderr || "ASR output was not JSON")
          });
        }
      });
    });
  }
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) return null;
  return {
    mime: match[1],
    bytes: Buffer.from(match[2], "base64")
  };
}

function extensionForMime(mime) {
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("opus")) return "opus";
  return "wav";
}

function windowsPathToWsl(value) {
  const normalized = path.resolve(value);
  const match = /^([A-Za-z]):\\(.*)$/.exec(normalized);
  if (!match) return normalized.replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function unavailable(kind) {
  return {
    ok: false,
    status: "not_configured",
    error: `${kind} is not configured`
  };
}

function cleanError(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

function appendWslEnv(existing, name) {
  const parts = String(existing || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(name)) parts.push(name);
  return parts.join(":");
}

module.exports = { AsrProvider };
