"""Paths and settings for the DeepSeek bridge."""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# AITS_DEEPSEEK_URL exists only for automated tests (a local fake chat page).
DEEPSEEK_URL = os.environ.get("AITS_DEEPSEEK_URL", "https://chat.deepseek.com/")

# Run the DeepSeek window headless (tests only; you cannot log in without a visible window).
HEADLESS = os.environ.get("AITS_HEADLESS") == "1"

# Optional override of the chat selectors, if DeepSeek changes its markup.
SELECTORS_FILE = Path(os.environ.get("AITS_SELECTORS_FILE", Path(__file__).resolve().parents[1] / "deepseek_selectors.json"))

# Separate, persistent Chrome profile, only for DeepSeek. Login survives restarts;
# nothing is copied from the user's main profile.
PROFILE_DIR = Path(os.environ.get("AITS_PROFILE_DIR", PROJECT_ROOT / "chrome-profile" / "deepseek"))
LOG_DIR = Path(os.environ.get("AITS_LOG_DIR", PROJECT_ROOT / "logs"))
TEST_PAGES_DIR = PROJECT_ROOT / "test-pages"
# Lecture notes: one folder per lecture (audio, transcript, .docx).
NOTES_DIR = Path(os.environ.get("AIH_NOTES_DIR", PROJECT_ROOT / "Конспекты"))

HOST = "127.0.0.1"
PORT = int(os.environ.get("AITS_PORT", "8765"))

# Requests to the API must carry this header. Browsers cannot add a custom header
# cross-origin without a CORS preflight, which the server only allows for extensions.
CLIENT_HEADER = "X-AITS-Client"
CLIENT_HEADER_VALUE = "ai-test-solver"

VERSION = "2.1.0"
