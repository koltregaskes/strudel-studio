@echo off
setlocal

set "PORT=8031"
set "URL=http://127.0.0.1:%PORT%/"

echo Starting Strudel Studio on %URL%
start "" %URL%
python -m http.server %PORT%
