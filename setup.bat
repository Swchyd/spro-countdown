@echo off
title SPro Countdown - Setup
cd /d "%~dp0"

echo.
echo   ================================================
echo    SPro Countdown  -  one-time setup
echo   ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed on this computer.
  echo.
  echo   Get it from  https://nodejs.org  ^(the LTS button^),
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

echo   Downloading what the app needs. This takes a few minutes
echo   the first time - about 250 MB.
echo.

call npm install --no-audit --no-fund
if errorlevel 1 goto failed

REM npm 11 no longer runs a package's install script on its own, and Electron
REM fetches its runtime in exactly that step - so it has to be run by hand.
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   Fetching the Electron runtime...
  node node_modules\electron\install.js
)

if not exist "node_modules\electron\dist\electron.exe" goto failed

echo.
echo   Done. Starting the app now - it will add an icon to your Desktop.
echo   From now on just double-click that icon.
echo.
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:failed
echo.
echo   Setup did not finish. Read the messages above for the reason.
echo.
echo   If it cannot download, this computer needs internet for the
echo   setup only - the app itself never needs it afterwards.
echo.
pause
exit /b 1
