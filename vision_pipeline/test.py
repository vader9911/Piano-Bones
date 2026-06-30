import sys
print("Hello from test.py!", flush=True)
print(f"Python executable: {sys.executable}", flush=True)
try:
    import cv2
    print("cv2 imported successfully", flush=True)
except Exception as e:
    print(f"cv2 error: {e}", flush=True)

try:
    import mediapipe as mp
    print("mediapipe imported successfully", flush=True)
except Exception as e:
    print(f"mediapipe error: {e}", flush=True)
