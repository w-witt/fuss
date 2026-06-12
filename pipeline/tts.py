"""Text-to-speech via edge-tts with word-level timestamp generation."""

import asyncio
import json
import os
import logging
from typing import List

import edge_tts

from config import TTS_VOICE
from pipeline.text_processor import TextSegment

logger = logging.getLogger(__name__)

SEGMENT_SEPARATOR = '. '


def synthesize(segments: List[TextSegment], output_dir: str, job_id: str,
               voice: str = None) -> dict:
    """Generate MP3 audio and word-level timestamps from text segments.

    Returns dict with paths: {"audio", "vtt", "sync_map"}
    """
    voice = voice or TTS_VOICE
    os.makedirs(output_dir, exist_ok=True)

    audio_path = os.path.join(output_dir, 'audio.mp3')
    vtt_path = os.path.join(output_dir, 'subs.vtt')
    sync_map_path = os.path.join(output_dir, 'sync_map.json')

    full_text, segment_word_counts = _build_full_text(segments)

    word_boundaries = asyncio.run(
        _generate_audio(full_text, audio_path, voice)
    )

    _write_vtt(word_boundaries, vtt_path)

    sync_map = _build_sync_map(word_boundaries, segment_word_counts)
    with open(sync_map_path, 'w', encoding='utf-8') as f:
        json.dump(sync_map, f)

    return {
        'audio': audio_path,
        'vtt': vtt_path,
        'sync_map': sync_map_path,
    }


def _build_full_text(segments: List[TextSegment]):
    """Concatenate segment texts. Track word count per segment for mapping."""
    parts = []
    segment_word_counts = []  # (segment_index, word_count)

    for seg in segments:
        word_count = len(seg.text.split())
        segment_word_counts.append((seg.index, word_count))
        parts.append(seg.text)

    full_text = SEGMENT_SEPARATOR.join(parts)
    return full_text, segment_word_counts


async def _generate_audio(text: str, audio_path: str, voice: str):
    """Stream edge-tts output, saving audio and collecting word boundaries."""
    communicate = edge_tts.Communicate(text, voice, boundary='WordBoundary')
    word_boundaries = []

    with open(audio_path, 'wb') as audio_file:
        async for chunk in communicate.stream():
            if chunk['type'] == 'audio':
                audio_file.write(chunk['data'])
            elif chunk['type'] == 'WordBoundary':
                word_boundaries.append({
                    'offset': chunk['offset'],
                    'duration': chunk['duration'],
                    'text': chunk['text'],
                })

    return word_boundaries


def _write_vtt(word_boundaries: list, vtt_path: str):
    """Write WebVTT subtitle file from word boundary events."""
    with open(vtt_path, 'w', encoding='utf-8') as f:
        f.write('WEBVTT\n\n')
        for i, wb in enumerate(word_boundaries):
            start_time = _format_vtt_time(wb['offset'])
            end_time = _format_vtt_time(wb['offset'] + wb['duration'])
            f.write(f'{i + 1}\n')
            f.write(f'{start_time} --> {end_time}\n')
            f.write(f'{wb["text"]}\n\n')


def _format_vtt_time(ticks: int) -> str:
    """Convert 100-nanosecond ticks to VTT timestamp HH:MM:SS.mmm."""
    total_ms = ticks // 10000
    hours = total_ms // 3600000
    minutes = (total_ms % 3600000) // 60000
    seconds = (total_ms % 60000) // 1000
    ms = total_ms % 1000
    return f'{hours:02d}:{minutes:02d}:{seconds:02d}.{ms:03d}'


def _build_sync_map(word_boundaries: list, segment_word_counts: list) -> dict:
    """Map word boundaries to segments using sequential word counts.

    Each segment contributed N words to the full text. We assign word
    boundaries to segments in order based on those counts.
    """
    words = []
    segment_times = {}

    # Build a flat list: for each word position, which segment it belongs to
    word_to_segment = []
    for seg_idx, count in segment_word_counts:
        word_to_segment.extend([seg_idx] * count)

    for i, wb in enumerate(word_boundaries):
        start_ms = wb['offset'] // 10000
        end_ms = (wb['offset'] + wb['duration']) // 10000

        seg_idx = word_to_segment[i] if i < len(word_to_segment) else 0

        words.append({
            'start_time_ms': start_ms,
            'end_time_ms': end_ms,
            'text': wb['text'],
            'segment_index': seg_idx,
        })

        if seg_idx not in segment_times:
            segment_times[seg_idx] = {'start': start_ms, 'end': end_ms}
        else:
            segment_times[seg_idx]['end'] = end_ms

    segments = [
        {'segment_index': idx, 'start_time_ms': times['start'], 'end_time_ms': times['end']}
        for idx, times in sorted(segment_times.items())
    ]

    return {'words': words, 'segments': segments}
