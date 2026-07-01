import sys
import os
import socket
import json
import time

print("Starting Polyphony Vision tracker with Homography Calibration...", flush=True)

try:
    import cv2
except Exception as e:
    print(f"Error importing cv2: {e}", flush=True)
    sys.exit(1)

try:
    import numpy as np
except Exception as e:
    print(f"Error importing numpy: {e}", flush=True)
    sys.exit(1)

try:
    import mediapipe as mp
    mp_hands = mp.solutions.hands
    print("Successfully imported mediapipe hands.", flush=True)
except Exception as e:
    print(f"Error importing mediapipe: {e}", flush=True)
    sys.exit(1)

# UDP Configuration
UDP_IP = "127.0.0.1"
UDP_PORT = 5005
print(f"Initializing UDP socket on {UDP_IP}:{UDP_PORT}...", flush=True)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# Destination Calibration Rectangle Parameters (88-key piano aspect ratio)
# You can adjust these variables to match the dimensions/aspect ratio of your frontend layout.
# Standard piano keys have a high width-to-depth ratio, so 1200x150 is ideal.
DST_WIDTH = 1200
DST_HEIGHT = 150

# Path to save/load calibration matrix data
CALIBRATION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calibration.json")

def save_calibration(points):
    """Saves the 4 captured pixel coordinate anchors to a local JSON file."""
    try:
        with open(CALIBRATION_FILE, "w") as f:
            json.dump(points, f)
        print(f"Calibration anchors saved successfully to {CALIBRATION_FILE}", flush=True)
    except Exception as e:
        print(f"Failed to save calibration: {e}", flush=True)

def load_calibration():
    """Loads 4 saved pixel coordinate anchors from a local JSON file if they exist."""
    if os.path.exists(CALIBRATION_FILE):
        try:
            with open(CALIBRATION_FILE, "r") as f:
                points = json.load(f)
            if isinstance(points, list) and len(points) == 4:
                print(f"Loaded existing calibration anchors from {CALIBRATION_FILE}:", flush=True)
                for idx, pt in enumerate(points):
                    print(f"  Anchor {idx + 1}: {pt}", flush=True)
                return points
        except Exception as e:
            print(f"Failed to load calibration: {e}", flush=True)
    return None

# Load initial calibration anchors if available
calibration_points = load_calibration() or []
calibration_step = -1  # -1 means normal tracking mode. 0 to 3 indicates calibration steps.
M = None  # Homography transformation matrix

def compute_homography_matrix(src_points):
    """
    Computes the 3x3 Perspective Transformation (Homography) matrix
    that maps 4 skewed camera coordinates (src) to a clean, flat rectangle (dst).
    """
    global M
    if len(src_points) != 4:
        M = None
        return None
    
    # Define source points (the captured trapezoid corners on raw camera space)
    src_pts = np.float32(src_points)
    
    # Define destination points (perfect digital rectangle)
    # The order MUST correspond exactly to the 4 captured steps:
    # 1. Top-Left corner of lowest key -> (0, 0)
    # 2. Bottom-Left corner of lowest key -> (0, DST_HEIGHT)
    # 3. Top-Right corner of highest key -> (DST_WIDTH, 0)
    # 4. Bottom-Right corner of highest key -> (DST_WIDTH, DST_HEIGHT)
    dst_pts = np.float32([
        [0, 0],                  # Step 1: Top-Left
        [0, DST_HEIGHT],         # Step 2: Bottom-Left
        [DST_WIDTH, 0],          # Step 3: Top-Right
        [DST_WIDTH, DST_HEIGHT]  # Step 4: Bottom-Right
    ])
    
    # Calculate the 3x3 perspective warp matrix
    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    print("Computed 3x3 Homography Matrix successfully.", flush=True)
    return M

# Compute M immediately if existing calibration anchors were loaded
if len(calibration_points) == 4:
    compute_homography_matrix(calibration_points)

# MediaPipe Configuration
print("Initializing MediaPipe...", flush=True)
try:
    hands = mp_hands.Hands(
        static_image_mode=False,
        max_num_hands=2,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    )
except Exception as e:
    print(f"CRITICAL ERROR initializing MediaPipe: {e}", flush=True)
    sys.exit(1)

# Camera State & Configuration
camera_status = "CONNECTING"

def send_status_update():
    """Sends a minimal telemetry payload indicating the current camera status."""
    payload = {
        "timestamp": time.time(),
        "hands": [],
        "camera_status": camera_status
    }
    try:
        msg = json.dumps(payload).encode('utf-8')
        sock.sendto(msg, (UDP_IP, UDP_PORT))
    except Exception as e:
        pass

def init_camera(index=0, max_attempts=5, retry_delay=1.0):
    """
    Attempts to initialize the camera at the given index.
    Performs a self-test by opening the stream and verifying we can read a valid frame.
    If the self-test fails, it retries up to max_attempts times.
    """
    global camera_status
    print(f"Opening camera stream on index {index}...", flush=True)
    for attempt in range(1, max_attempts + 1):
        camera_status = f"CONNECTING_ATTEMPT_{attempt}"
        print(f"Camera initialization attempt {attempt}/{max_attempts}...", flush=True)
        send_status_update()
        try:
            if os.name == 'nt':
                cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
            else:
                cap = cv2.VideoCapture(index)
            
            if cap.isOpened():
                # Configure Camera properties
                cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1200)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 800)
                cap.set(cv2.CAP_PROP_FPS, 100)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                
                # Perform self-test: try to read a few frames to ensure it's actually streaming
                test_success = False
                for _ in range(5):
                    success, frame = cap.read()
                    if success and frame is not None and frame.size > 0:
                        test_success = True
                        break
                    time.sleep(0.1)
                
                if test_success:
                    print(f"Camera self-test SUCCESSFUL on index {index}!", flush=True)
                    camera_status = "OK"
                    send_status_update()
                    return cap
                else:
                    print(f"Camera opened but failed self-test (could not read frame) on index {index}.", flush=True)
                    cap.release()
            else:
                print(f"Failed to open camera on index {index}.", flush=True)
        except Exception as e:
            print(f"Error during camera initialization on index {index}: {e}", flush=True)
        
        if attempt < max_attempts:
            print(f"Waiting {retry_delay}s before retrying...", flush=True)
            time.sleep(retry_delay)
            
    camera_status = "FAILED_SELF_TEST"
    send_status_update()
    return None

# Initial Camera connection & self-test
cap = init_camera(index=0)

# Command socket configuration (to receive commands from backend/frontend like "restart_camera")
CMD_IP = "127.0.0.1"
CMD_PORT = 5006
cmd_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
cmd_sock.setblocking(False)
try:
    cmd_sock.bind((CMD_IP, CMD_PORT))
    print(f"Listening for camera commands on UDP {CMD_IP}:{CMD_PORT}...", flush=True)
except Exception as e:
    print(f"Warning: Could not bind command socket: {e}", flush=True)

print("\n=== KEYBOARD ALIGNMENT INSTRUCTIONS ===", flush=True)
print("Press 'c' in the video window to START 4-point calibration.", flush=True)
print("Press 'r' to RESET/CLEAR current calibration mapping.", flush=True)
print("Press 'q' to EXIT the tracking script.", flush=True)
print("While calibrating, press 'SPACEBAR' to capture each anchor point.", flush=True)
print("=======================================\n", flush=True)

# List of descriptions to guide the user on-screen
STEP_DESCRIPTIONS = [
    "Step 1/4: Touch TOP-LEFT corner of LOWEST key & press SPACEBAR",
    "Step 2/4: Touch BOTTOM-LEFT corner of LOWEST key & press SPACEBAR",
    "Step 3/4: Touch TOP-RIGHT corner of HIGHEST key & press SPACEBAR",
    "Step 4/4: Touch BOTTOM-RIGHT corner of HIGHEST key & press SPACEBAR"
]

try:
    frame_count = 0
    show_window = True  # Enable local GUI window for calibration guidance and feedback
    consecutive_failures = 0
    force_restart = False
    
    while True:
        # 1. Handle command interface
        try:
            cmd_data, cmd_addr = cmd_sock.recvfrom(1024)
            cmd_payload = json.loads(cmd_data.decode('utf-8'))
            command = cmd_payload.get("command")
            print(f"Received camera command: {command}", flush=True)
            if command == "restart_camera" or command == "self_test":
                force_restart = True
        except BlockingIOError:
            pass
        except Exception as e:
            print(f"Error checking command socket: {e}", flush=True)

        # 2. Re-establish camera if closed, failed, or force-restarted
        if cap is None or not cap.isOpened() or force_restart:
            print("Camera not open or restart requested. Running self-test & initialization...", flush=True)
            if cap is not None:
                cap.release()
            camera_status = "RESTARTING"
            send_status_update()
            time.sleep(1.0)
            cap = init_camera(index=0)
            force_restart = False
            consecutive_failures = 0
            if cap is None:
                print("Failed to re-initialize camera. Waiting 2.0 seconds before next attempt...", flush=True)
                time.sleep(2.0)
                continue

        success, frame = cap.read()
        if not success:
            consecutive_failures += 1
            print(f"Ignoring empty camera frame (Consecutive failure count: {consecutive_failures}).", flush=True)
            if consecutive_failures >= 30:  # Detect stuck or turned off camera
                print("Too many consecutive empty frames. Automatic camera restart triggered...", flush=True)
                force_restart = True
            time.sleep(0.05)
            continue
            
        consecutive_failures = 0
            
        frame_count += 1
        frame_height, frame_width = frame.shape[:2]
        
        # Performance/Hardware: grayscale-to-RGB fast translation
        if len(frame.shape) == 2:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2RGB)
        else:
            gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            rgb_frame = cv2.cvtColor(gray_frame, cv2.COLOR_GRAY2RGB)

        # Feed frame to MediaPipe Hands model
        results = hands.process(rgb_frame)

        # Prepare BGR canvas for visual GUI feedback
        display_frame = cv2.cvtColor(rgb_frame, cv2.COLOR_RGB2BGR)

        # Draw existing calibration polygon
        if len(calibration_points) == 4:
            pts = np.array(calibration_points, np.int32).reshape((-1, 1, 2))
            cv2.polylines(display_frame, [pts], True, (46, 204, 113), 2)  # green polygon boundary
            
            # Connect corner points to visual labels
            for idx, pt in enumerate(calibration_points):
                cv2.circle(display_frame, (int(pt[0]), int(pt[1])), 6, (46, 204, 113), -1)
                cv2.putText(display_frame, f"C{idx + 1}", (int(pt[0]) + 10, int(pt[1]) - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (46, 204, 113), 1, cv2.LINE_AA)

        # Active Index fingertip coordinate for calibration (Landmark 8)
        index_tip_px = None
        if results.multi_hand_landmarks:
            # We use the first detected hand for calibration interactions
            primary_hand = results.multi_hand_landmarks[0]
            tip_lm = primary_hand.landmark[8]
            index_tip_px = (int(tip_lm.x * frame_width), int(tip_lm.y * frame_height))
            
            # Highlight index fingertip with active calibration reticle
            if calibration_step >= 0:
                cv2.circle(display_frame, index_tip_px, 12, (52, 152, 219), 2)  # Orange outer ring
                cv2.circle(display_frame, index_tip_px, 4, (0, 0, 255), -1)      # Red target point

        # Render On-screen Calibration HUD Overlay
        if calibration_step >= 0:
            # Dim the background a bit to focus on instructions
            overlay = display_frame.copy()
            cv2.rectangle(overlay, (0, 0), (frame_width, 60), (0, 0, 0), -1)
            cv2.addWeighted(overlay, 0.4, display_frame, 0.6, 0, display_frame)
            
            # Draw Instruction Text
            cv2.putText(display_frame, "CALIBRATION MODE ACTIVE", (20, 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (52, 152, 219), 2, cv2.LINE_AA)
            cv2.putText(display_frame, STEP_DESCRIPTIONS[calibration_step], (20, 48),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            
            # Draw current landmarks collected so far
            for idx, pt in enumerate(calibration_points):
                cv2.circle(display_frame, (int(pt[0]), int(pt[1])), 8, (52, 152, 219), -1)
                cv2.putText(display_frame, f"S{idx+1}", (int(pt[0]) + 12, int(pt[1]) + 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        else:
            # Render regular state overlay info
            cv2.rectangle(display_frame, (10, 10), (320, 50), (30, 30, 30), -1)
            status_text = "STATUS: CALIBRATED (MAPPED)" if M is not None else "STATUS: RAW CAMERA SPACE"
            status_color = (46, 204, 113) if M is not None else (128, 128, 128)
            cv2.putText(display_frame, status_text, (20, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, status_color, 1, cv2.LINE_AA)
            cv2.putText(display_frame, "Press 'c' to start 4-point calibration", (20, 42),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (180, 180, 180), 1, cv2.LINE_AA)

        # Prepare Outgoing Telemetry Payload
        payload = {
            "timestamp": time.time(),
            "hands": [],
            "camera_status": camera_status
        }

        if results.multi_hand_landmarks and results.multi_handedness:
            for hand_landmarks, handedness in zip(results.multi_hand_landmarks, results.multi_handedness):
                landmarks_flat = []
                
                # Check if homography calibration is active
                if M is not None:
                    # 1. Map 21 landmarks into standard pixel coordinates on camera frame
                    landmarks_pixel = []
                    for lm in hand_landmarks.landmark:
                        landmarks_pixel.append([lm.x * frame_width, lm.y * frame_height])
                    
                    # Convert to float32 NumPy array for cv2.perspectiveTransform
                    pts_to_warp = np.array([landmarks_pixel], dtype=np.float32)
                    
                    # 2. Warp camera coordinates to flat keyboard rectangle dimensions (DST_WIDTH x DST_HEIGHT)
                    pts_warped = cv2.perspectiveTransform(pts_to_warp, M)
                    warped_pixel = pts_warped[0]
                    
                    # 3. Normalize coordinates relative to destination rectangle dimensions
                    for i, (x_w, y_w) in enumerate(warped_pixel):
                        norm_x = x_w / DST_WIDTH
                        norm_y = y_w / DST_HEIGHT
                        orig_z = hand_landmarks.landmark[i].z
                        
                        # Pack flattened (x, y, z) structure
                        landmarks_flat.extend([round(norm_x, 5), round(norm_y, 5), round(orig_z, 5)])
                else:
                    # Standard fallback: send raw camera coordinate landmarks
                    for lm in hand_landmarks.landmark:
                        landmarks_flat.extend([round(lm.x, 5), round(lm.y, 5), round(lm.z, 5)])
                
                payload["hands"].append({
                    "handedness": handedness.classification[0].label,
                    "score": round(handedness.classification[0].score, 3),
                    "landmarks": landmarks_flat
                })

        # Broadcast telemetry payload via UDP
        msg = json.dumps(payload).encode('utf-8')
        sock.sendto(msg, (UDP_IP, UDP_PORT))

        # Render display window
        if show_window:
            cv2.imshow('Polyphony Camera Calibration & Hand Tracker', display_frame)
            
            # Key action handlings
            key = cv2.waitKey(1) & 0xFF
            
            if key == ord('q'):
                break
            elif key == ord('c'):
                # Enter Calibration mode
                calibration_step = 0
                calibration_points = []
                M = None
                print("Starting 4-point calibration sequence...", flush=True)
                print(STEP_DESCRIPTIONS[0], flush=True)
            elif key == ord('r'):
                # Reset calibration matrix & anchors
                calibration_points = []
                M = None
                calibration_step = -1
                if os.path.exists(CALIBRATION_FILE):
                    try:
                        os.remove(CALIBRATION_FILE)
                        print("Calibration file deleted.", flush=True)
                    except Exception as e:
                        print(f"Error deleting calibration file: {e}", flush=True)
                print("Calibration reset. Reverted back to raw camera space coordinates.", flush=True)
            elif key == 32:  # Spacebar keypress
                if calibration_step >= 0:
                    if index_tip_px is not None:
                        # Capture active index fingertip position
                        calibration_points.append(list(index_tip_px))
                        print(f"Captured Anchor {calibration_step + 1}/4 at: {index_tip_px}", flush=True)
                        calibration_step += 1
                        
                        # Check if calibration steps are finished
                        if calibration_step == 4:
                            compute_homography_matrix(calibration_points)
                            save_calibration(calibration_points)
                            calibration_step = -1
                            print("Homography calibration matrix constructed successfully!", flush=True)
                        else:
                            print(STEP_DESCRIPTIONS[calibration_step], flush=True)
                    else:
                        print("WARNING: No hand detected in frame! Place your index finger exactly on the corner target and press Spacebar.", flush=True)

except KeyboardInterrupt:
    print("\nStopping vision pipeline gracefully...")
finally:
    if cap is not None:
        cap.release()
    cv2.destroyAllWindows()
    sock.close()
    cmd_sock.close()
    print("Polyphony tracker closed.", flush=True)
