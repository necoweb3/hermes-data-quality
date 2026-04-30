import subprocess
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: run_hermes_review.py <prompt-file>", file=sys.stderr)
        return 2

    with open(sys.argv[1], "r", encoding="utf-8") as prompt_file:
        prompt = prompt_file.read()

    result = subprocess.run(
        ["hermes", "--skills", "data-quality-gate", "chat", "-q", prompt],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
