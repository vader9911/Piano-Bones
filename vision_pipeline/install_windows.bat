@echo off
echo =======================================================
echo Polyphony Vision Pipeline Setup
echo =======================================================
echo.
echo Checking system Python version (Recommended: 3.9, 3.10, or 3.11)...
python --version

echo.
echo 1. Creating virtual environment (venv) in the current directory...
python -m venv venv

echo.
echo 2. Activating virtual environment...
call venv\Scripts\activate

echo.
echo 3. Upgrading pip inside the virtual environment...
python -m pip install --upgrade pip

echo.
echo 4. Setting UTF-8 Encoding to fix Windows installation errors...
set PYTHONUTF8=1

echo.
echo 5. Installing required packages into the isolated environment...
pip install -r requirements.txt

echo.
echo =======================================================
echo Installation Verification
echo =======================================================
echo Python executable being used:
where python
echo.
python -c "import sys; print('Python version inside venv:', sys.version)"
python -c "import mediapipe as mp; print('MediaPipe installed successfully! Version:', mp.__version__)"

echo.
echo =======================================================
echo Setup Complete!
echo =======================================================
echo To run the tracker from a NEW terminal window in the future:
echo   1. cd vision_pipeline
echo   2. call venv\Scripts\activate
echo   3. python tracker.py
echo =======================================================
echo.
pause
