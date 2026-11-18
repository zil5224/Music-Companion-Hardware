@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\NeteaseCloudMusicApi\app.js" (
  echo Missing dependencies. Run "npm.cmd ci" in this folder first.
  pause
  exit /b 1
)
echo Music Companion is starting. Open http://localhost:8080 when it is ready.
echo Press Ctrl+C to stop.
call npm.cmd start
pause