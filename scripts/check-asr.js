const path = require("path");
const dotenv = require("dotenv");
const { AsrProvider } = require("../src/providers/asr");

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

async function main() {
  const provider = new AsrProvider();
  console.log("ASR configuration");
  const status = provider.describe();
  for (const [key, value] of Object.entries(status)) {
    console.log(`- ${key}: ${value}`);
  }

  const result = await provider.transcribeDataUrl(makeSilentWavDataUrl());
  console.log(`\nasr smoke test: ${result.ok ? "ok" : "not ok"} (${result.status})`);
  if (!result.ok) console.log(`  ${result.error}`);
  else console.log(`  transcript: ${result.payload.transcript || "(empty)"}`);
}

function makeSilentWavDataUrl() {
  const sampleRate = 16000;
  const samples = sampleRate;
  const dataSize = samples * 2;
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
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  return `data:audio/wav;base64,${Buffer.from(buffer).toString("base64")}`;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
