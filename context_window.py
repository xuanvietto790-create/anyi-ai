"""Count with the official V4 tokenizer; allow the model's full 1,048,576 window."""
import os
from functools import lru_cache
from pathlib import Path

CONTEXT_WINDOW = 1_048_576
OUTPUT_TOKENS = 8192
PROTOCOL_MARGIN = 1024
MAX_RAW_CHARS = 16_000_000


@lru_cache(maxsize=1)
def tokenizer():
    path = Path(os.getenv('DEEPSEEK_TOKENIZER_PATH', 'E:/Codex/tool-cache/models/deepseek-v4-tokenizer.json'))
    if not path.is_file():
        return None
    from tokenizers import Tokenizer
    return Tokenizer.from_file(str(path))


def text_tokens(text):
    encoder = tokenizer()
    if encoder is None:
        # Conservative fallback; explicitly labelled in the API/UI.
        return len(text.encode('utf-8'))
    return len(encoder.encode(text, add_special_tokens=False).ids)


def budget(messages, system=''):
    count = text_tokens(system) + sum(text_tokens(m['content']) + 16 for m in messages) + 16
    return {
        'input_tokens': count, 'limit': CONTEXT_WINDOW,
        'reserved_output_tokens': OUTPUT_TOKENS, 'protocol_margin': PROTOCOL_MARGIN,
        'remaining_tokens': max(0, CONTEXT_WINDOW - count - OUTPUT_TOKENS - PROTOCOL_MARGIN),
        'fits': count + OUTPUT_TOKENS + PROTOCOL_MARGIN <= CONTEXT_WINDOW,
        'estimated': True,
        'method': 'deepseek-v4-tokenizer' if tokenizer() else 'conservative-byte-estimate',
    }
