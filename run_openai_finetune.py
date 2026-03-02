#!/usr/bin/env python3
"""
Convert train.jsonl to OpenAI fine-tuning format and start a fine-tuning job.

Requires:
  - .env with OPENAI_API_KEY set
  - train.jsonl in project root (run build_train_jsonl.py first if needed)

Usage:
  pip install -r requirements-train.txt
  python run_openai_finetune.py
"""

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("Missing OPENAI_API_KEY in .env", file=sys.stderr)
    sys.exit(1)

# Lazy import so we fail fast on missing key
import httpx
from openai import APIConnectionError, OpenAI

# Long timeout for large file upload; retries below
client = OpenAI(
    api_key=OPENAI_API_KEY,
    timeout=httpx.Timeout(300.0),
)

TRAIN_JSONL = Path("train.jsonl")
OPENAI_TRAIN_JSONL = Path("train_openai.jsonl")
MODEL = "gpt-4o-mini"
SUFFIX = "vertical-script"  # your fine-tuned model will be named like gpt-4o-mini:ft:::vertical-script:xxxx

SYSTEM_PROMPT = """You are a vertical script generator. Given control tags (language, genre, episode count, optional logline), you output a complete vertical/short-form script in the exact format used for episodic vertical video: scene headings (INT./EXT. LOCATION - DAY/NIGHT), action blocks, and dialogue (CHARACTER then lines). Output only the script text, no commentary."""


def convert_to_openai_format():
    """Convert train.jsonl (input/output) to OpenAI messages format."""
    if not TRAIN_JSONL.exists():
        print(f"Run build_train_jsonl.py first to create {TRAIN_JSONL}", file=sys.stderr)
        sys.exit(1)

    count = 0
    with TRAIN_JSONL.open("r", encoding="utf-8") as f_in, OPENAI_TRAIN_JSONL.open(
        "w", encoding="utf-8"
    ) as f_out:
        for line in f_in:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            user_content = rec.get("input", "")
            assistant_content = rec.get("output", "")
            if not user_content or not assistant_content:
                continue
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content},
            ]
            f_out.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")
            count += 1

    print(f"Converted {count} examples to {OPENAI_TRAIN_JSONL}")
    return count


def upload_and_finetune():
    """Upload train_openai.jsonl and create fine-tuning job."""
    if not OPENAI_TRAIN_JSONL.exists():
        convert_to_openai_format()

    print("Uploading training file to OpenAI...")
    file_id = None
    for attempt in range(3):
        try:
            with OPENAI_TRAIN_JSONL.open("rb") as f:
                file_response = client.files.create(file=f, purpose="fine-tune")
            file_id = file_response.id
            break
        except APIConnectionError as e:
            print(f"Upload attempt {attempt + 1}/3 failed: {e}")
            if attempt == 2:
                print("\nUpload failed (often due to proxy/firewall). Upload train_openai.jsonl manually at https://platform.openai.com/fine-tuning then run:")
                print("  python run_openai_finetune.py --file-id <your-file-id>")
                print("See FINE_TUNE_MANUAL.md for full steps.")
                raise
            import time
            time.sleep(5)
        except Exception as e:
            print(f"Upload attempt {attempt + 1}/3 failed: {e}")
            if attempt == 2:
                raise
            import time
            time.sleep(5)

    if file_id is None:
        raise RuntimeError("Upload failed after retries")
    print(f"Uploaded file_id: {file_id}")

    print("Creating fine-tuning job (this may take a while)...")
    job = client.fine_tuning.jobs.create(
        training_file=file_id,
        model=MODEL,
        suffix=SUFFIX,
        hyperparameters={"n_epochs": 2},
    )

    print(f"Fine-tuning job created: {job.id}")
    print(f"Status: {job.status}")
    print("Monitor progress at: https://platform.openai.com/fine-tuning")
    print("When status is 'succeeded', note the fine_tuned_model name for your backend.")
    return job.id


def create_job_with_file_id(file_id: str):
    """Call after uploading train_openai.jsonl manually; pass the file ID from the UI."""
    print("Creating fine-tuning job...")
    job = client.fine_tuning.jobs.create(
        training_file=file_id,
        model=MODEL,
        suffix=SUFFIX,
        hyperparameters={"n_epochs": 2},
    )
    print(f"Job created: {job.id} | Status: {job.status}")
    print("Monitor: https://platform.openai.com/fine-tuning")
    return job.id


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Build OpenAI fine-tune data and/or start job")
    parser.add_argument("--file-id", type=str, help="Use this file ID (from manual upload) to create job only")
    args = parser.parse_args()

    convert_to_openai_format()
    if args.file_id:
        create_job_with_file_id(args.file_id)
    else:
        upload_and_finetune()
