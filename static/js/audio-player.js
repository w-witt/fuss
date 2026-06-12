/**
 * Audio player: wraps the HTML5 audio element with playback controls.
 */

const AudioPlayer = (function () {
    const audio = document.getElementById('audio-element');
    const btnPlay = document.getElementById('btn-play');
    const iconPlay = document.getElementById('icon-play');
    const iconPause = document.getElementById('icon-pause');
    const progressBar = document.getElementById('progress-bar');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');
    const speedSelect = document.getElementById('speed-select');

    let onTimeUpdate = null;  // callback(currentTimeMs)

    function init(audioUrl, timeUpdateCallback) {
        audio.src = audioUrl;
        onTimeUpdate = timeUpdateCallback;

        audio.addEventListener('loadedmetadata', () => {
            timeTotal.textContent = formatTime(audio.duration);
            progressBar.max = Math.floor(audio.duration * 10) / 10;
        });

        audio.addEventListener('timeupdate', () => {
            timeCurrent.textContent = formatTime(audio.currentTime);
            progressBar.value = audio.currentTime;
            if (onTimeUpdate) {
                onTimeUpdate(audio.currentTime * 1000);
            }
        });

        audio.addEventListener('ended', () => {
            iconPlay.style.display = '';
            iconPause.style.display = 'none';
        });

        btnPlay.addEventListener('click', togglePlay);

        progressBar.addEventListener('input', () => {
            audio.currentTime = parseFloat(progressBar.value);
        });

        speedSelect.addEventListener('change', () => {
            audio.playbackRate = parseFloat(speedSelect.value);
        });
    }

    function togglePlay() {
        if (audio.paused) {
            audio.play();
            iconPlay.style.display = 'none';
            iconPause.style.display = '';
        } else {
            audio.pause();
            iconPlay.style.display = '';
            iconPause.style.display = 'none';
        }
    }

    function seekTo(timeMs) {
        audio.currentTime = timeMs / 1000;
    }

    function isPlaying() {
        return !audio.paused;
    }

    function formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    return { init, togglePlay, seekTo, isPlaying };
})();
