#!/usr/bin/env sh
# Mac / Linux: ./run.sh  then open http://localhost:8000
cd "$(dirname "$0")"
python3 -m venv .venv 2>/dev/null
. .venv/bin/activate
pip install -q -r requirements.txt
uvicorn app.main:app --reload --port 8000
