"""Web synth backend: serves the frontend and stores presets as JSON."""
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).parent
PRESET_FILE = BASE / "presets.json"

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
    return FileResponse(BASE / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")