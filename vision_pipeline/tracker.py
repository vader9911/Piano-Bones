import sys
print("Starting Polyphony Vision tracker...", flush=True)

try:
    import cv2
except Exception as e:
    print(f"Error importing cv2: {e}", flush=True)
    sys.exit(1)

try:
    import mediapipe as mp
    mp_hands = mp.solutions.hands
    print("Successfully imported mediapipe hands.", flush=True)
except Exception as e:
    print(f"Error importing mediapipe: {e}", flush=True)
    print("If you are on Windows, try setting PYTHONUTF8=1 before installing:", flush=True)
    print("set PYTHONUTF8=1", flush=True)
    print("pip install --force-reinstall mediapipe==0.10.13", flush=True)
    sys.exit(1)

import socket
import json
import time

# UDP Configuration
UDP_IP = "127.0.0.1"
UDP_PORT = 5005
print("Initializing UDP socket...", flush=True)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# MediaPipe Configuration
print("Initializing MediaPipe...", flush=True)
try:
    hands = mp_hands.Hands(
        static_image_mode=False,
        max_num_hands=2,
        model_complexity=0,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    )
except Exception as e:
    print(f"CRITICAL ERROR initializing MediaPipe: {e}", flush=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Camera Configuration
print("Opening camera (this may take a few seconds)...", flush=True)
# Try DirectShow on Windows if standard fails, but standard is first.
# Some Windows systems hang on VideoCapture(0) without CAP_DSHOW.
import os
if os.name == 'nt':
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
else:
    cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("Error: Could not open camera at index 0.", flush=True)
    print("Please check if your camera is connected, or if another app is using it.", flush=True)
    print("You may also need to change the camera index to 1 or 2.", flush=True)
    sys.exit(1)

print("Camera opened successfully. Setting resolution and FPS...", flush=True)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
cap.set(cv2.CAP_PROP_FPS, 100)

print(f"Starting vision pipeline. Sending telemetry to {UDP_IP}:{UDP_PORT}...", flush=True)

try:
    frame_count = 0
    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            print("Ignoring empty camera frame.", flush=True)
            continue
            
        frame_count += 1
        if frame_count % 100 == 0:
            print(f"[{time.strftime('%H:%M:%S')}] Pipeline running... (processed {frame_count} frames)", flush=True)
            
        # Optimization & Hardware Constraint:
        # The stream from Arducam OV9281 is 1-channel grayscale.
        # However, OpenCV's default backend on many platforms reads it as a 3-channel BGR image
        # with identical channels. MediaPipe explicitly requires RGB.
        # To be safe and meet the requirement, we extract the grayscale intensity
        # and convert it precisely to RGB.
        if len(frame.shape) == 2:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2RGB)
        else:
            gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            rgb_frame = cv2.cvtColor(gray_frame, cv2.COLOR_GRAY2RGB)

        # Process the frame with MediaPipe
        results = hands.process(rgb_frame)

        payload = {
            "timestamp": time.time(),
            "hands": []
        }

        if results.multi_hand_landmarks and results.multi_handedness:
            for hand_landmarks, handedness in zip(results.multi_hand_landmarks, results.multi_handedness):
                # Flatten the 21 landmarks (x, y, z) into a single 1D array of 63 floats
                # This minimizes JSON string length and parsing overhead for ultra-low latency.
                landmarks_flat = []
                for lm in hand_landmarks.landmark:
                    landmarks_flat.extend([round(lm.x, 5), round(lm.y, 5), round(lm.z, 5)])
                
                payload["hands"].append({
                    "handedness": handedness.classification[0].label,
                    "score": round(handedness.classification[0].score, 3),
                    "landmarks": landmarks_flat
                })
        
        # Serialize and send only if hands are detected to save network bandwidth
        if payload["hands"]:
            msg = json.dumps(payload).encode('utf-8')
            sock.sendto(msg, (UDP_IP, UDP_PORT))
            
        # Display the frame for visual confirmation (Disabled to maximize FPS at 100hz)
        # Uncomment the lines below if you need local visual debugging, 
        # but note it will significantly reduce the camera framerate.
        # cv2.imshow('Polyphony Vision (Press q to exit)', rgb_frame)
        # if cv2.waitKey(1) & 0xFF == ord('q'):
        #     break
            
except KeyboardInterrupt:
    print("\nStopping vision pipeline...")
finally:
    cap.release()
    cv2.destroyAllWindows()
    sock.close()
