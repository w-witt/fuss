"""Pipeline orchestrator: ties PDF extraction, text processing, and TTS together."""

import json
import os
import uuid
import shutil
import logging
import time

from config import UPLOAD_FOLDER, OUTPUT_FOLDER
from pipeline.extractor import extract_mmd
from pipeline.text_processor import process_mmd, segments_to_dicts
from pipeline.tts import synthesize

logger = logging.getLogger(__name__)


def create_job(pdf_file_storage) -> str:
    """Save an uploaded PDF and return a new job ID."""
    job_id = uuid.uuid4().hex[:12]
    job_upload_dir = os.path.join(UPLOAD_FOLDER, job_id)
    os.makedirs(job_upload_dir, exist_ok=True)

    pdf_path = os.path.join(job_upload_dir, 'paper.pdf')
    pdf_file_storage.save(pdf_path)
    return job_id


def run_pipeline(job_id: str) -> dict:
    """Run the full processing pipeline for a job.

    Returns a dict with status and paths to generated files.
    """
    pdf_path = os.path.join(UPLOAD_FOLDER, job_id, 'paper.pdf')
    output_dir = os.path.join(OUTPUT_FOLDER, job_id)
    os.makedirs(output_dir, exist_ok=True)

    if not os.path.isfile(pdf_path):
        raise FileNotFoundError(f"PDF not found for job {job_id}")

    # Step 1: Extract MMD from PDF
    logger.info("[%s] Step 1: Extracting text from PDF...", job_id)
    mmd_path = extract_mmd(pdf_path, output_dir)

    with open(mmd_path, 'r', encoding='utf-8') as f:
        mmd_content = f.read()

    # Step 2: Process MMD into speakable segments
    logger.info("[%s] Step 2: Processing text into segments...", job_id)
    segments = process_mmd(mmd_content)

    if not segments:
        raise ValueError("No text segments could be extracted from the PDF")

    # Save segments JSON
    segments_path = os.path.join(output_dir, 'segments.json')
    with open(segments_path, 'w', encoding='utf-8') as f:
        json.dump(segments_to_dicts(segments), f, indent=2)

    # Step 3: Generate audio + timestamps
    logger.info("[%s] Step 3: Generating audio...", job_id)
    tts_result = synthesize(segments, output_dir, job_id)

    logger.info("[%s] Pipeline complete.", job_id)
    return {
        'job_id': job_id,
        'segments': segments_path,
        'audio': tts_result['audio'],
        'vtt': tts_result['vtt'],
        'sync_map': tts_result['sync_map'],
    }


def get_job_file(job_id: str, filename: str) -> str:
    """Get the path to a job output file, or None if it doesn't exist."""
    path = os.path.join(OUTPUT_FOLDER, job_id, filename)
    if os.path.isfile(path):
        return path
    return None


def get_pdf_path(job_id: str) -> str:
    """Get the path to the uploaded PDF for a job."""
    path = os.path.join(UPLOAD_FOLDER, job_id, 'paper.pdf')
    if os.path.isfile(path):
        return path
    return None


def cleanup_old_jobs(max_age_hours: int = 24):
    """Remove job directories older than max_age_hours."""
    now = time.time()
    cutoff = now - (max_age_hours * 3600)

    for folder in [UPLOAD_FOLDER, OUTPUT_FOLDER]:
        if not os.path.isdir(folder):
            continue
        for entry in os.listdir(folder):
            entry_path = os.path.join(folder, entry)
            if os.path.isdir(entry_path):
                mtime = os.path.getmtime(entry_path)
                if mtime < cutoff:
                    shutil.rmtree(entry_path, ignore_errors=True)
                    logger.info("Cleaned up old job: %s", entry)
