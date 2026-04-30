import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-file", required=True)
    parser.add_argument("--server", default="grpc.nvcf.nvidia.com:443")
    parser.add_argument("--function-id", required=True)
    parser.add_argument("--language-code", default="en-US")
    args = parser.parse_args()

    api_key = os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        print(json.dumps({"ok": False, "error": "NVIDIA_API_KEY is missing"}))
        return 2

    try:
        import grpc
        import riva.client
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"nvidia-riva-client is not installed: {exc}"}))
        return 3

    auth = riva.client.Auth(
        use_ssl=True,
        uri=args.server,
        metadata_args=[
            ["function-id", args.function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr_service = riva.client.ASRService(auth)
    config = riva.client.RecognitionConfig(
        language_code=args.language_code,
        max_alternatives=1,
        enable_automatic_punctuation=True,
        verbatim_transcripts=True,
        enable_word_time_offsets=True,
    )

    with open(args.input_file, "rb") as audio_file:
        audio = audio_file.read()

    try:
        response = asr_service.offline_recognize(audio, config)
    except grpc.RpcError as exc:
        print(json.dumps({"ok": False, "error": exc.details() or str(exc)}))
        return 4

    transcripts = []
    words = []
    for result in response.results:
        if not result.alternatives:
            continue
        alternative = result.alternatives[0]
        if alternative.transcript:
            transcripts.append(alternative.transcript)
        for word in alternative.words:
            words.append(
                {
                    "word": word.word,
                    "confidence": getattr(word, "confidence", None),
                    "start": duration_to_seconds(word.start_time),
                    "end": duration_to_seconds(word.end_time),
                }
            )

    print(
        json.dumps(
            {
                "ok": True,
                "transcript": " ".join(transcripts).strip(),
                "words": words[:200],
            },
            ensure_ascii=True,
        )
    )
    return 0


def duration_to_seconds(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return getattr(value, "seconds", 0) + getattr(value, "nanos", 0) / 1_000_000_000


if __name__ == "__main__":
    sys.exit(main())
