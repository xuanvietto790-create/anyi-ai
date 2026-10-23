"""Offline Chinese ASR and Windows SAPI TTS; no browser speech cloud required."""
import asyncio
import io
import json
import os
import sys
import threading
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException

ASR_LIMIT = 12 * 1024 * 1024
MAX_SECONDS = 90
_model_lock = threading.Lock()
speech_slots = asyncio.Semaphore(2)


def model_path():
    return Path(os.getenv('ANYI_VOSK_MODEL', 'E:/Codex/tool-cache/models/vosk-model-small-cn-0.22'))


def capabilities():
    return {'recognition': (model_path() / 'am/final.mdl').exists(), 'synthesis': sys.platform == 'win32',
            'engine': 'Vosk 中文本地识别', 'max_seconds': MAX_SECONDS}


@lru_cache(maxsize=1)
def recognition_model():
    from vosk import Model, SetLogLevel
    SetLogLevel(-1)
    if not capabilities()['recognition']:
        raise HTTPException(503, '本地中文语音模型尚未安装，请运行 setup_assets.py')
    return Model(str(model_path()))


def transcribe(data):
    import av
    from vosk import KaldiRecognizer
    with _model_lock:
        model = recognition_model()
    recognizer = KaldiRecognizer(model, 16000)
    parts, samples = [], 0
    try:
        with av.open(io.BytesIO(data)) as container:
            if not container.streams.audio:
                raise HTTPException(400, '文件没有音轨，请上传录音文件')
            resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
            def consume(frame):
                nonlocal samples
                samples += frame.samples
                if samples > (MAX_SECONDS + 0.5) * 16000:
                    raise HTTPException(413, '录音最长 90 秒，请分段识别')
                pcm = bytes(frame.planes[0])[:frame.samples * 2]
                if recognizer.AcceptWaveform(pcm):
                    parts.append(json.loads(recognizer.Result()).get('text', ''))
            for frame in container.decode(audio=0):
                for converted in resampler.resample(frame):
                    consume(converted)
            for converted in resampler.resample(None):
                consume(converted)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, '录音无法解码，请上传 WAV、MP3、M4A、OGG 或 WebM 音频') from None
    parts.append(json.loads(recognizer.FinalResult()).get('text', ''))
    text = ''.join(parts).strip()
    # Vosk separates Chinese words with spaces; retain spaces around Latin text.
    import re
    text = re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])', '', text)
    if not text:
        raise HTTPException(422, '没有识别到清晰语音，请靠近麦克风说普通话后重试')
    return {'text': text, 'seconds': round(samples / 16000, 2), 'engine': 'Vosk 本地中文识别'}


async def synthesize(text, rate):
    if sys.platform != 'win32':
        raise HTTPException(503, '此本地朗读后端需要 Windows，请使用系统浏览器朗读')
    process = await asyncio.create_subprocess_exec(
        sys.executable, '-B', str(Path(__file__).with_name('speech_worker.py')),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(json.dumps({'text': text, 'rate': rate}).encode()), 45)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.communicate()
        raise
    if process.returncode != 0 or not output.startswith(b'RIFF'):
        raise HTTPException(503, 'Windows 中文朗读未能生成音频，请检查系统是否安装中文语音包')
    return output
