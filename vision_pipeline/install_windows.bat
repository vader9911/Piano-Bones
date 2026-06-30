@echo off
echo Cleaning up previous MediaPipe installations...
pip uninstall -y mediapipe

echo.
echo Setting UTF-8 Encoding to fix the installation error...
set PYTHONUTF8=1

echo.
echo Installing MediaPipe...
pip install mediapipe opencv-python

echo.
echo Installation complete. Testing import...
python -c "import mediapipe as mp; print('MediaPipe installed successfully! Version:', mp.__version__)"

echo.
pause
