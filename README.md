# Dual Subs remote

Phone remote for the Netflix Dual Subs Chrome extension: play/pause, jump between
subtitle lines, show the English on the TV, and tap words to look them up, mark them
or ask AI about them while Netflix plays on the computer (e.g. cast to a TV).

Live at https://alexknight0.github.io/dual-subs-remote/. Talks to the extension through
Firebase Realtime Database (project `dual-subs-2b0407`), `/remote/{uid}/state`, `/panel`
(written by the extension) and `/command` (written here). Only the owner's account can
read or write.

- Test: `~/projects/ai-tool-venv/bin/python3 test/test_remote.py`
- Icons: `~/projects/ai-tool-venv/bin/python3 tools/make_icons.py`
- After cloning: `ln -sf ../../tools/pre-commit .git/hooks/pre-commit` (stamps `version.js`)
