"""Local server for Pulso.

Serves the game and, for YouTube links, downloads the song's audio with yt-dlp
so the browser can analyse the whole track before playing.

    pip install yt-dlp
    python server.py
"""
import json
import mimetypes
import re
import sys
import threading
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8765
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
MAX_SECONDS = 15 * 60
ID_RE = re.compile(r"^[\w-]{11}$")

mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/webm", ".webm")
mimetypes.add_type("text/javascript", ".js")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def lock_for(video_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(video_id, threading.Lock())


def fetch_song(video_id: str) -> dict:
    """Download the audio once and cache it next to its metadata."""
    meta_path = CACHE / f"{video_id}.json"
    with lock_for(video_id):
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if (CACHE / meta["file"]).exists():
                return meta

        try:
            import yt_dlp
        except ImportError:
            raise RuntimeError("yt-dlp não está instalado. Rode: pip install yt-dlp")

        CACHE.mkdir(exist_ok=True)
        url = f"https://www.youtube.com/watch?v={video_id}"
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
            "outtmpl": str(CACHE / "%(id)s.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "js_runtimes": {"node": {}},
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if (info.get("duration") or 0) > MAX_SECONDS:
                raise RuntimeError("Vídeo longo demais (máximo 15 minutos).")
            info = ydl.extract_info(url, download=True)
            path = Path(ydl.prepare_filename(info))

        meta = {
            "id": video_id,
            "title": info.get("title") or video_id,
            "duration": info.get("duration"),
            "file": path.name,
        }
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return meta


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/song":
            video_id = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
            if not ID_RE.match(video_id):
                return self.send_json(400, {"error": "Link do YouTube inválido."})
            try:
                meta = fetch_song(video_id)
            except Exception as exc:  # report yt-dlp errors to the page
                return self.send_json(500, {"error": str(exc)})
            return self.send_json(200, {**meta, "url": f"/cache/{urllib.parse.quote(meta['file'])}"})
        return super().do_GET()

    def send_json(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}/"
    print(f"Pulso rodando em {url}  (Ctrl+C para parar)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
