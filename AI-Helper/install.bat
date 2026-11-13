@echo off
rem AI Helper: one-click setup. Installs whatever is missing (Python, Node.js) into the "tools"
rem folder next to this file, builds the extension, installs the bridge libraries and makes a
rem desktop shortcut. Safe to run again: finished steps are skipped.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set code=%errorlevel%
echo.
pause
exit /b %code%
