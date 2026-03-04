#!/usr/bin/env python3
"""
Convert v2 training data to OpenAI fine-tuning format and optionally start a job.

Requires:
  - .env with OPENAI_API_KEY set
  - train_v2.jsonl in project root (run build_train_v2_jsonl.py first)

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

TRAIN_JSONL = Path("train_v2.jsonl")
OPENAI_TRAIN_JSONL = Path("train_openai_v2.jsonl")
MODEL = "gpt-4o-mini"
SUFFIX = "vertical-script"  # your fine-tuned model will be named like gpt-4o-mini:ft:::vertical-script:xxxx

SYSTEM_PROMPT = """You are a vertical episode writer for short-form / vertical dramas.

The user sends you a JSON object called `input` that describes:
- show_id
- episode number
- total_episodes_for_show
- arc_phase (hook / escalation / lock_in / spin_out)
- a list of scenes, each with scene_id, location, beat_type, arc_phase, and characters.

You MUST respond with a JSON array of blocks. Each block is an object with:
- block_id (e.g. "E12_S1_B3")
- episode (number)
- scene_id (e.g. "E12_S1")
- type: "action" or "dialogue"
- speaker: character name in ALL CAPS for dialogue blocks, or null/omitted for action
- text: the actual script line

Follow the episode plan closely, write vivid but concise action, and natural, character-driven dialogue.
Maintain a strong hook in the first few blocks and end on a clear cliffhanger or question.
Do NOT include any extra commentary or metadata outside the JSON array of blocks.
"""


def convert_to_openai_format():
    """Convert train_v2.jsonl (structured input/output) to OpenAI messages format."""
    if not TRAIN_JSONL.exists():
        print(f"Run build_train_v2_jsonl.py first to create {TRAIN_JSONL}", file=sys.stderr)
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

            ep_input = rec.get("input")
            ep_output = rec.get("output")
            if not ep_input or not ep_output:
                continue

            # Serialize structured input/output as JSON strings for the chat API
            user_content = json.dumps(ep_input, ensure_ascii=False)
            assistant_content = json.dumps(ep_output, ensure_ascii=False)

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
    parser.add_argument("--convert-only", action="store_true", help="Only convert train_v2.jsonl to OpenAI format and exit")
    args = parser.parse_args()

    convert_to_openai_format()
    if args.convert_only:
        sys.exit(0)
    if args.file_id:
        create_job_with_file_id(args.file_id)
    else:
        upload_and_finetune()
