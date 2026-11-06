@echo off
rem AI Helper: DeepSeek bridge (tests and lecture notes).
rem First run creates a virtual environment and installs the requirements;
rem they are installed again when requirements.txt changes.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [bridge] Creating virtual environment...
  where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
  if errorlevel 1 (
    echo [bridge] Python 3.10+ not found. Install it from https://www.python.org/
    pause
    exit /b 1
  )
)

fc /b requirements.txt .venv\installed-requirements.txt >nul 2>nul
if errorlevel 1 (
  echo [bridge] Installing requirements, the first time this takes a few minutes...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 (
    echo [bridge] Failed to install requirements.
    pause
    exit /b 1
  )
  where nvidia-smi >nul 2>nul && (
    echo [bridge] NVIDIA GPU found: installing CUDA libraries for speech recognition...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements-gpu.txt
  )
  copy /y requirements.txt .venv\installed-requirements.txt >nul
)

".venv\Scripts\python.exe" -m deepseek_bridge %*
if errorlevel 1 pause
