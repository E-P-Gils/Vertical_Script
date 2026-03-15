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
TRAIN_GENRE_JSONL = Path("train_v2_genre_tagged.jsonl")
OPENAI_GENRE_JSONL = Path("train_openai_genre_tagged.jsonl")
MODEL = "gpt-4o-mini"
SUFFIX = "vertical-script"  # your fine-tuned model will be named like gpt-4o-mini:ft:::vertical-script:xxxx
SUFFIX_GENRE = "vertical-genre"  # second model: genre-conditioned

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

SYSTEM_PROMPT_GENRE = SYSTEM_PROMPT + """

The input may include genre_tag (e.g. Horror, Superhero, Adventure) and setting_hint. Use them to flavor tone, setting, and vocabulary while keeping the same vertical format, dialogue-led structure, and hooks. Output is always a JSON array of blocks.
"""


def convert_to_openai_format(genre_tagged: bool = False):
    """Convert train_v2.jsonl or train_v2_genre_tagged.jsonl to OpenAI messages format.
    Output file has one JSON object per line with key 'messages' (required by OpenAI).
    Do NOT upload the raw *train_v2*.jsonl file; upload the converted *train_openai*.jsonl file.
    """
    src = TRAIN_GENRE_JSONL if genre_tagged else TRAIN_JSONL
    out = OPENAI_GENRE_JSONL if genre_tagged else OPENAI_TRAIN_JSONL
    system = SYSTEM_PROMPT_GENRE if genre_tagged else SYSTEM_PROMPT
    if not src.exists():
        print(f"Create {src} first: run build_train_v2_genre_tagged.py" if genre_tagged else f"Run build_train_v2_jsonl.py first to create {src}", file=sys.stderr)
        sys.exit(1)

    count = 0
    with src.open("r", encoding="utf-8") as f_in, out.open("w", encoding="utf-8") as f_out:
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

            user_content = json.dumps(ep_input, ensure_ascii=False)
            assistant_content = json.dumps(ep_output, ensure_ascii=False)

            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content},
            ]
            openai_record = {"messages": messages}
            f_out.write(json.dumps(openai_record, ensure_ascii=False) + "\n")
            count += 1

    if count == 0:
        print("No valid records converted.", file=sys.stderr)
        sys.exit(1)
    # Validate first line has "messages"
    with out.open("r", encoding="utf-8") as f:
        first = json.loads(f.readline())
    if "messages" not in first:
        print("Validation failed: first line missing 'messages' key.", file=sys.stderr)
        sys.exit(1)
    print(f"Converted {count} examples to {out}")
    print(f"  -> Upload {out.name} to OpenAI (NOT {src.name})")
    return count


def upload_and_finetune(genre_tagged: bool = False):
    """Upload train_openai*.jsonl and create fine-tuning job."""
    out = OPENAI_GENRE_JSONL if genre_tagged else OPENAI_TRAIN_JSONL
    if not out.exists():
        convert_to_openai_format(genre_tagged=genre_tagged)

    print(f"Uploading {out} to OpenAI...")
    file_id = None
    for attempt in range(3):
        try:
            with out.open("rb") as f:
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

    suffix = SUFFIX_GENRE if genre_tagged else SUFFIX
    print(f"Creating fine-tuning job (suffix={suffix}, this may take a while)...")
    job = client.fine_tuning.jobs.create(
        training_file=file_id,
        model=MODEL,
        suffix=suffix,
        hyperparameters={"n_epochs": 2},
    )

    print(f"Fine-tuning job created: {job.id}")
    print(f"Status: {job.status}")
    print("Monitor progress at: https://platform.openai.com/fine-tuning")
    print("When status is 'succeeded', note the fine_tuned_model name for your backend.")
    return job.id


def create_job_with_file_id(file_id: str, genre_tagged: bool = False):
    """Call after uploading train_openai*.jsonl manually; pass the file ID from the UI."""
    suffix = SUFFIX_GENRE if genre_tagged else SUFFIX
    print(f"Creating fine-tuning job (suffix={suffix})...")
    job = client.fine_tuning.jobs.create(
        training_file=file_id,
        model=MODEL,
        suffix=suffix,
        hyperparameters={"n_epochs": 2},
    )
    print(f"Job created: {job.id} | Status: {job.status}")
    print("Monitor: https://platform.openai.com/fine-tuning")
    return job.id


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Build OpenAI fine-tune data and/or start job")
    parser.add_argument("--file-id", type=str, help="Use this file ID (from manual upload) to create job only")
    parser.add_argument("--convert-only", action="store_true", help="Only convert to OpenAI format and exit")
    parser.add_argument("--genre-tagged", action="store_true", help="Use train_v2_genre_tagged.jsonl for genre-conditioned model (second model)")
    args = parser.parse_args()

    convert_to_openai_format(genre_tagged=args.genre_tagged)
    if args.convert_only:
        out_name = OPENAI_GENRE_JSONL.name if args.genre_tagged else OPENAI_TRAIN_JSONL.name
        print(f"Done. Upload {out_name} at https://platform.openai.com/fine-tuning then run with --file-id <id>" + (" --genre-tagged" if args.genre_tagged else ""))
        sys.exit(0)
    if args.file_id:
        create_job_with_file_id(args.file_id, genre_tagged=args.genre_tagged)
    else:
        upload_and_finetune(genre_tagged=args.genre_tagged)
