# WebSynth

A browser synthesizer: playable keys, two oscillators, ADSR envelope, filter, 4-band EQ,
oscilloscope and spectrum, and a piano roll. All sound is made in the browser with the
Web Audio API, so it needs no server.

## Play it on GitHub Pages

1. Repo **Settings → Pages**
2. **Build and deployment → Deploy from a branch**
3. Branch `main`, folder `/ (root)`, then Save
4. Open `https://<your-username>.github.io/<repo-name>/` after a minute

Presets are saved in your browser (localStorage).

## Run locally with the Python backend (optional)

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --reload
```

Open http://localhost:8000. Presets are then saved to `presets.json` on the server.
Opening `index.html` directly from disk also works, with presets in the browser.

## Controls

- Keys: `Z S X D C V G B H N J M` (lower row), `Q 2 W 3 E R 5 T 6 Y 7 U I 8 O 9 P` (upper row), `← →` change octave
- Piano roll: click or drag to draw 1/8 notes, drag to move, drag a note's right edge to resize,
  click or right-click a note to delete, mouse wheel for octaves, `Space` to play / stop