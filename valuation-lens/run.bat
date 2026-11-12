@echo off
REM Windows: double-click run.bat, then open http://localhost:8000
cd /d %~dp0
if not exist .venv python -m venv .venv
call .venv\Scripts\activate
pip install -q -r requirements.txt
uvicorn app.main:app --reload --port 8000
