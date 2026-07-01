import { Injectable, signal } from '@angular/core';

export interface HandData {
  handedness: string;
  score: number;
  landmarks: number[];
}

export interface TelemetryPayload {
  timestamp: number;
  hands: HandData[];
  camera_status?: string;
}

@Injectable({
  providedIn: 'root'
})
export class TelemetryService {
  public data = signal<TelemetryPayload | null>(null);
  public connected = signal<boolean>(false);
  public cameraStatus = signal<string>('UNKNOWN');
  public logs = signal<string[]>([]);
  public metrics = signal({
    leftWristHeightCm: 0,
    leftMcpFlexionDeg: 0,
    rightWristHeightCm: 0,
    rightMcpFlexionDeg: 0,
    jitterMs: 0
  });

  private ws: WebSocket | null = null;
  private lastMessageTime = 0;

  constructor() {
    this.connect();
  }

  private connect() {
    if (typeof window === 'undefined') return;

    // Protocol relative WebSocket URL, using same host/port.
    // Connect directly to the user's local .NET backend running on port 5000.
    // Since the frontend is hosted but the user's backend is local,
    // we must use the local address rather than going through the remote proxy.
    const wsUrl = `ws://127.0.0.1:5000/ws`;
    
    this.log(`Attempting to connect WebSocket to ${wsUrl}...`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.connected.set(true);
      this.log('SUCCESS: WEBSOCKET_CONNECTED');
    };

    this.ws.onmessage = (event) => {
      const now = performance.now();
      if (this.lastMessageTime > 0) {
        const jitter = now - this.lastMessageTime;
        // Simple smoothing for display
        this.metrics.update(m => ({ ...m, jitterMs: m.jitterMs * 0.9 + jitter * 0.1 }));
      }
      this.lastMessageTime = now;

      try {
        const payload: TelemetryPayload = JSON.parse(event.data);
        this.data.set(payload);

        if (payload.camera_status) {
          this.cameraStatus.set(payload.camera_status);
        }

        // Compute derived metrics for both hands if present
        if (payload.hands.length > 0) {
          let leftWristHeightCm = 0;
          let leftMcpFlexionDeg = 0;
          let rightWristHeightCm = 0;
          let rightMcpFlexionDeg = 0;

          payload.hands.forEach(hand => {
            if (hand.landmarks && hand.landmarks.length >= 30) {
              // Wrist is landmark 0 (x,y,z are indices 0,1,2) -> Y is index 1
              const wristY = hand.landmarks[1];
              const middleMcpY = hand.landmarks[28]; // middle mcp Y is index 9 * 3 + 1 = 28

              const simulatedHeight = Math.max(0, (1.0 - wristY) * 30);
              const simulatedFlexion = Math.abs(middleMcpY - wristY) * 300;

              const isLeft = hand.handedness.toLowerCase().includes('left');
              if (isLeft) {
                rightWristHeightCm = simulatedHeight;
                rightMcpFlexionDeg = simulatedFlexion;
              } else {
                leftWristHeightCm = simulatedHeight;
                leftMcpFlexionDeg = simulatedFlexion;
              }

              if (wristY > middleMcpY + 0.05) {
                if (Math.random() < 0.02) {
                  this.log(`WARN: ${hand.handedness.toUpperCase()} WRIST_ANGLE_THRESHOLD_EXCEEDED (${simulatedFlexion.toFixed(1)}deg)`);
                }
              }
            }
          });

          this.metrics.update(m => ({
            ...m,
            leftWristHeightCm: leftWristHeightCm || m.leftWristHeightCm,
            leftMcpFlexionDeg: leftMcpFlexionDeg || m.leftMcpFlexionDeg,
            rightWristHeightCm: rightWristHeightCm || m.rightWristHeightCm,
            rightMcpFlexionDeg: rightMcpFlexionDeg || m.rightMcpFlexionDeg
          }));
        }
      } catch (err) {
        console.error('Failed to parse telemetry', err);
      }
    };

    this.ws.onclose = () => {
      this.connected.set(false);
      this.log('ERROR: WEBSOCKET_DISCONNECTED. Reconnecting in 2s...');
      setTimeout(() => this.connect(), 2000);
    };
    
    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  sendCommand(command: 'restart_camera' | 'self_test') {
    if (this.ws && this.connected()) {
      const payload = { command };
      this.ws.send(JSON.stringify(payload));
      this.log(`COMMAND_SENT: ${command.toUpperCase()}`);
    } else {
      this.log(`COMMAND_FAILED: WebSocket not connected`);
    }
  }

  log(msg: string) {
    const timestamp = new Date().toISOString().split('T')[1].substring(0, 12);
    const formatted = `[${timestamp}] ${msg}`;
    this.logs.update(logs => {
      const newLogs = [formatted, ...logs];
      if (newLogs.length > 50) newLogs.pop();
      return newLogs;
    });
  }
}
