# Fine-tune via OpenAI dashboard (if script upload fails)

If `python run_openai_finetune.py` fails with a connection error (e.g. proxy/firewall), upload the file and start the job from the OpenAI UI, then create the job from the script using the file ID.

## Step 1: Generate the training file

```bash
python run_openai_finetune.py
```

This creates/updates `train_openai.jsonl`. When the upload step fails, continue below.

## Step 2: Upload the file in the OpenAI dashboard

1. Open **https://platform.openai.com/fine-tuning**
2. Click **"Upload file"** (or **"Create"** → **"File"** / **"New file"**).
3. Select: `c:\Users\sculp\Desktop\Vertical_Script\train_openai.jsonl`
4. Choose purpose **"Fine-tuning"**.
5. After the upload finishes, copy the **File ID** (e.g. `file-abc123...`).

## Step 3: Create the fine-tuning job from the script

Using the file ID from step 2:

```bash
python run_openai_finetune.py --file-id file-xxxxxxxxxxxx
```

Replace `file-xxxxxxxxxxxx` with your actual file ID. The script will create the job (model: gpt-4o-mini, 2 epochs, suffix: vertical-script) and print the job ID and link.

## Step 4: Wait and get the model name

- Monitor the job at **https://platform.openai.com/fine-tuning**.
- When status is **succeeded**, copy the **fine-tuned model** name (e.g. `gpt-4o-mini:ft:...:vertical-script:xxxx`).
- Use that model name in your backend for script generation.
