@echo off
title SPro Countdown - Server (fallback)
cd /d "%~dp0"

REM Fallback launcher. Normally you open the "SPro Countdown" shortcut, which
REM runs the desktop app with no console window. Use this file instead if the
REM app will not start - for example if antivirus blocks electron.exe, or on a
REM computer where "npm install" was never run.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo   Install it once from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

start "" http://localhost:8080
node server.js

echo.
echo   Server stopped.
pause
