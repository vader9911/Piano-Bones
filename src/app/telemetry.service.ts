import { Injectable, signal } from '@angular/core';

export interface HandData {
  handedness: string;
  score: number;
  landmarks: number[];
}

export interface TelemetryPayload {
  timestamp: number;
  hands: HandData[];
}

@Injectable({
  providedIn: 'root'
})
export class TelemetryService {
  public data = signal<TelemetryPayload | null>(null);
  public connected = signal<boolean>(false);
  public logs = signal<string[]>([]);
  public metrics = signal({
    wristHeightCm: 0,
    mcpFlexionDeg: 0,
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
    // In dev, Angular proxy will forward /ws to .NET backend.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
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

        // Compute some derived metrics if hands are present
        if (payload.hands.length > 0) {
          const hand = payload.hands[0];
          if (hand.landmarks && hand.landmarks.length >= 30) {
            // Wrist is landmark 0 (x,y,z at indices 0,1,2)
            // Y is index 1. In MediaPipe, Y is normalized 0.0 to 1.0 (top to bottom).
            // Let's pretend 1.0 = 50cm for a physical mockup display.
            const wristY = hand.landmarks[1];
            const middleMcpY = hand.landmarks[28]; // index 9 Y

            const simulatedHeight = Math.max(0, (1.0 - wristY) * 30); // simplistic conversion
            const simulatedFlexion = Math.abs(middleMcpY - wristY) * 300; 

            this.metrics.update(m => ({
              ...m,
              wristHeightCm: simulatedHeight,
              mcpFlexionDeg: simulatedFlexion
            }));

            if (wristY > middleMcpY + 0.05) {
              // Throttle warnings
              if (Math.random() < 0.05) {
                this.log(`WARN: WRIST_ANGLE_THRESHOLD_EXCEEDED (${simulatedFlexion.toFixed(1)}deg)`);
              }
            }
          }
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

  private log(msg: string) {
    const timestamp = new Date().toISOString().split('T')[1].substring(0, 12);
    const formatted = `[${timestamp}] ${msg}`;
    this.logs.update(logs => {
      const newLogs = [formatted, ...logs];
      if (newLogs.length > 50) newLogs.pop();
      return newLogs;
    });
  }
}
