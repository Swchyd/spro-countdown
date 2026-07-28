@echo off
title SPro Countdown - Server
cd /d "%~dp0"

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
