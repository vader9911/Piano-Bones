import cv2
import mediapipe as mp
import socket
import json
import time

# UDP Configuration
UDP_IP = "127.0.0.1"
UDP_PORT = 5005
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# MediaPipe Configuration
mp_hands = mp.solutions.hands
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

# Camera Configuration
# The Arducam OV9281 is a monochrome global shutter camera.
# We set resolution to 720p and aim for 120 FPS.
cap = cv2.VideoCapture(0)
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
cap.set(cv2.CAP_PROP_FPS, 120)

print(f"Starting vision pipeline. Sending telemetry to {UDP_IP}:{UDP_PORT}...")

try:
    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            print("Ignoring empty camera frame.")
            continue
            
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
            
except KeyboardInterrupt:
    print("\nStopping vision pipeline...")
finally:
    cap.release()
    sock.close()
