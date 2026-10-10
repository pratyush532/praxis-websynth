"""Web synth backend (optional).

The synth itself runs entirely in the browser, so index.html also works on any
static host such as GitHub Pages. This server just serves the same files and
stores presets in presets.json instead of the browser's localStorage.

Run:  uvicorn app:app --reload      then open http://localhost:8000
"""
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE = Path(__file__).parent
PRESET_FILE = BASE / "presets.json"
# Only these files are served, so app.py and presets.json are never downloadable.
PAGE_FILES = {"style.css", "synth.js", "pianoroll.js"}

app = FastAPI(title="Web Synth")


class Preset(BaseModel):
    name: str
    params: dict


def load_presets() -> dict:
    if PRESET_FILE.exists():
        return json.loads(PRESET_FILE.read_text())
    return {}


@app.get("/api/presets")
def list_presets():
    return load_presets()


@app.post("/api/presets")
def save_preset(preset: Preset):
    name = preset.name.strip()
    if not name or len(name) > 40:
        raise HTTPException(400, "Preset name must be 1-40 characters")
    presets = load_presets()
    presets[name] = preset.params
    PRESET_FILE.write_text(json.dumps(presets, indent=2))
    return {"saved": name}


@app.delete("/api/presets/{name}")
def delete_preset(name: str):
    presets = load_presets()
    if name not in presets:
        raise HTTPException(404, "No such preset")
    del presets[name]
    PRESET_FILE.write_text(json.dumps(presets, indent=2))
    return {"deleted": name}


@app.get("/")
def index():
    return FileResponse(BASE / "index.html")


@app.get("/{filename}")
def page_file(filename: str):
    if filename not in PAGE_FILES:
        raise HTTPException(404, "Not found")
    return FileResponse(BASE / filename)