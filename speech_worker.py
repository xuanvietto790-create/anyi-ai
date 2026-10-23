"""Separate process isolates the SAPI COM apartment and never plays on the host."""
import json
import os
import sys
import uuid
from pathlib import Path


def main():
    # comtypes generated wrappers are cache files too: keep them on E:.
    import comtypes.client
    cache = Path('E:/Codex/tool-cache/comtypes')
    cache.mkdir(parents=True, exist_ok=True)
    comtypes.client.gen_dir = str(cache)
    request = json.loads(sys.stdin.buffer.read())
    folder = Path(os.getenv('ANYI_TEMP_DIR', 'E:/Codex/tmp/anyi-ai'))
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f'tts-{uuid.uuid4()}.wav'
    stream = None
    try:
        voice = comtypes.client.CreateObject('SAPI.SpVoice', dynamic=True)
        voices = voice.GetVoices()
        for index in range(voices.Count):
            candidate = voices.Item(index)
            if any(lang.lower() in {'804', '0804', '404', '0404'} for lang in candidate.GetAttribute('Language').split(';')):
                voice.Voice = candidate
                break
        else:
            raise RuntimeError('Chinese voice unavailable')
        stream = comtypes.client.CreateObject('SAPI.SpFileStream', dynamic=True)
        stream.Open(str(target), 3)
        voice.AudioOutputStream = stream
        voice.Rate = max(-4, min(5, round((float(request.get('rate', 1)) - 1) * 8)))
        voice.Speak(request['text'], 0)
        stream.Close(); stream = None
        sys.stdout.buffer.write(target.read_bytes())
    finally:
        if stream:
            stream.Close()
        target.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
