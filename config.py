import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
OUTPUT_FOLDER = os.path.join(BASE_DIR, 'output')
MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB max upload

# edge-tts voice
TTS_VOICE = 'en-GB-SoniaNeural'
