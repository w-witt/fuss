import json
import logging
import os
from datetime import datetime, timezone

from flask import Flask, request, render_template, send_file, redirect, url_for, jsonify, abort

from config import UPLOAD_FOLDER, OUTPUT_FOLDER, FEEDBACK_FOLDER, MAX_CONTENT_LENGTH, GITHUB_REPO_URL
from pipeline.orchestrator import create_job, run_pipeline, get_job_file, get_pdf_path, cleanup_old_jobs

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# Clean up old jobs on startup
cleanup_old_jobs()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return 'No file uploaded', 400

    file = request.files['file']
    if file.filename == '' or not file.filename.lower().endswith('.pdf'):
        return 'Please upload a PDF file', 400

    try:
        job_id = create_job(file)
        run_pipeline(job_id)
        return redirect(url_for('reader', job_id=job_id))
    except Exception as e:
        logging.error("Pipeline failed: %s", e, exc_info=True)
        return f'Processing failed: {e}', 500


@app.route('/reader/<job_id>')
def reader(job_id):
    if not get_pdf_path(job_id):
        abort(404)
    return render_template('reader.html', job_id=job_id, repo_url=GITHUB_REPO_URL)


@app.route('/api/pdf/<job_id>')
def api_pdf(job_id):
    path = get_pdf_path(job_id)
    if not path:
        abort(404)
    return send_file(path, mimetype='application/pdf')


@app.route('/api/audio/<job_id>')
def api_audio(job_id):
    path = get_job_file(job_id, 'audio.mp3')
    if not path:
        abort(404)
    return send_file(path, mimetype='audio/mpeg')


@app.route('/api/vtt/<job_id>')
def api_vtt(job_id):
    path = get_job_file(job_id, 'subs.vtt')
    if not path:
        abort(404)
    return send_file(path, mimetype='text/vtt')


@app.route('/api/segments/<job_id>')
def api_segments(job_id):
    path = get_job_file(job_id, 'segments.json')
    if not path:
        abort(404)
    return send_file(path, mimetype='application/json')


@app.route('/api/sync_map/<job_id>')
def api_sync_map(job_id):
    path = get_job_file(job_id, 'sync_map.json')
    if not path:
        abort(404)
    return send_file(path, mimetype='application/json')


FEEDBACK_CATEGORIES = {'missed-latex', 'pronunciation', 'other'}


@app.route('/api/feedback/<job_id>', methods=['POST'])
def api_feedback(job_id):
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Invalid JSON body'}), 400

    category = data.get('category')
    comment = (data.get('comment') or '').strip()
    if category not in FEEDBACK_CATEGORIES:
        return jsonify({'error': 'Unknown category'}), 400
    if not comment:
        return jsonify({'error': 'Comment is required'}), 400

    context = data.get('context') or {}
    record = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'job_id': job_id,
        'category': category,
        'comment': comment[:5000],
        'word': str(context.get('word') or '')[:200],
        'segment_text': str(context.get('segment_text') or '')[:2000],
        'time_ms': context.get('time_ms'),
        'page': context.get('page'),
    }

    # Feedback outlives the 24h job cleanup, so the context snapshot above is
    # the only durable record of what was being read.
    os.makedirs(FEEDBACK_FOLDER, exist_ok=True)
    with open(os.path.join(FEEDBACK_FOLDER, 'feedback.jsonl'), 'a') as f:
        f.write(json.dumps(record) + '\n')

    return jsonify({'status': 'ok'}), 201


if __name__ == '__main__':
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    # Port 5050: macOS AirPlay Receiver squats on 5000
    app.run(debug=True, port=5050)
