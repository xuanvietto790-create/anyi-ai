"""Install only small local assets, entirely on E:. No model weights for the LLM."""
import hashlib
import os
import subprocess
import urllib.request
import zipfile
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name('.env'))
CACHE = Path('E:/Codex/tool-cache/models')
MODEL_SHA256 = '3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba'


def download(url, target):
    if target.exists():
        return
    partial = target.with_suffix(target.suffix + '.part')
    print(f'Downloading {target.name} to {target.parent}', flush=True)
    if os.name == 'nt':
        subprocess.run(['curl.exe', '-L', '--fail', '--retry', '3', '--connect-timeout', '20', '--max-time', '600', '-C', '-', '-o', str(partial), url], check=True)
    else:
        with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as output:
            while chunk := response.read(65536):
                output.write(chunk)
    partial.replace(target)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    model = CACHE / 'vosk-model-small-cn-0.22'
    if not (model / 'am/final.mdl').exists():
        archive_path = CACHE / 'vosk-model-small-cn-0.22.zip'
        download('https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip', archive_path)
        if hashlib.sha256(archive_path.read_bytes()).hexdigest() != MODEL_SHA256:
            raise RuntimeError('ASR model archive checksum mismatch. Remove the incomplete archive and retry.')
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                if not (CACHE / member.filename).resolve().is_relative_to(CACHE.resolve()):
                    raise RuntimeError('Invalid archive path')
            archive.extractall(CACHE)
    tokenizer = Path(os.getenv('DEEPSEEK_TOKENIZER_PATH', str(CACHE / 'deepseek-v4-tokenizer.json')))
    tokenizer.parent.mkdir(parents=True, exist_ok=True)
    download('https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/resolve/main/tokenizer.json', tokenizer)
    from tokenizers import Tokenizer
    Tokenizer.from_file(str(tokenizer))
    print('V4 tokenizer and local Chinese speech model are ready.', flush=True)


if __name__ == '__main__':
    main()
