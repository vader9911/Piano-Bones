using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Melanchall.DryWetMidi.Core;
using Melanchall.DryWetMidi.Multimedia;
using Melanchall.DryWetMidi.Common;

var builder = WebApplication.CreateBuilder(args);
// Bind to port 5000 for standard local API execution
builder.WebHost.UseUrls("http://localhost:5000");

var app = builder.Build();
app.UseWebSockets();

// Global active connections
var connectedClients = new List<WebSocket>();
var clientsLock = new object();
OutputDevice? midiOutput = null;

// Try to attach to a virtual MIDI loopback port (e.g., loopMIDI on Windows, IAC on Mac)
try 
{
    // The exact device name depends on the host OS configuration.
    midiOutput = OutputDevice.GetByName("loopMIDI Port");
    Console.WriteLine("Successfully connected to virtual MIDI loopback port.");
}
catch (Exception ex)
{
    Console.WriteLine($"[Warning] Could not initialize MIDI output: {ex.Message}. Continuing without MIDI.");
}

// ----------------------------------------------------
// 1. WEBSOCKET GATEWAY (Frontend Data Sink)
// ----------------------------------------------------
app.Map("/ws", async context =>
{
    if (context.WebSockets.IsWebSocketRequest)
    {
        using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
        Console.WriteLine("New Angular frontend client connected.");
        
        lock (clientsLock)
        {
            connectedClients.Add(webSocket);
        }

        var buffer = new byte[1024];
        try
        {
            // Keep connection alive and watch for client closure
            while (webSocket.State == WebSocketState.Open)
            {
                var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                }
            }
        }
        catch (WebSocketException) { /* Client disconnected abruptly */ }
        finally
        {
            lock (clientsLock)
            {
                connectedClients.Remove(webSocket);
            }
            Console.WriteLine("Frontend client disconnected.");
        }
    }
    else
    {
        context.Response.StatusCode = (int)HttpStatusCode.BadRequest;
    }
});

// ----------------------------------------------------
// 2. UDP LISTENER & KINEMATIC THRESHOLD MATH
// ----------------------------------------------------
Task.Run(async () =>
{
    using var udpClient = new UdpClient(5005);
    Console.WriteLine("Listening for Python telemetry on UDP 5005...");

    while (true)
    {
        try
        {
            var result = await udpClient.ReceiveAsync();
            var payloadBytes = result.Buffer;
            
            // 1. Deserialize to perform kinematic math & alert triggers
            var payloadString = Encoding.UTF8.GetString(payloadBytes);
            var telemetry = JsonSerializer.Deserialize<TelemetryPayload>(payloadString);

            if (telemetry?.Hands != null)
            {
                foreach (var hand in telemetry.Hands)
                {
                    // POSTURE MATH: Wrist Collapse Check
                    // MediaPipe landmark 0 is the Wrist. Landmark 9 is the middle finger MCP (knuckle).
                    // If the wrist's Y coordinate is significantly higher (lower on physical plane, since Y=0 is top)
                    // than the MCP's Y coordinate, it indicates the wrist has collapsed below the knuckles (poor piano posture).
                    if (hand.Landmarks != null && hand.Landmarks.Count >= 30) // Ensure enough data (21 points * 3 = 63 values)
                    {
                        float wristY = hand.Landmarks[1];      // index 1 is Y of landmark 0
                        float middleMcpY = hand.Landmarks[28]; // index 28 is Y of landmark 9 (9 * 3 + 1)
                        
                        // Example threshold condition
                        if (wristY > middleMcpY + 0.05f) 
                        {
                            // In a real application, we might debounce this to prevent spamming
                            Console.WriteLine($"[ALERT] Wrist collapsed on {hand.Handedness} hand.");
                            
                            // Send MIDI feedback (e.g., trigger a warning sound, filter cutoff change, or CC message)
                            if (midiOutput != null)
                            {
                                // Send Control Change (CC 1 - Mod Wheel) value 127
                                midiOutput.SendEvent(new ControlChangeEvent((SevenBitNumber)1, (SevenBitNumber)127));
                            }
                        }
                    }
                }
            }

            // 2. Broadcast raw JSON to all active WebSockets (zero-copy string mapping for max speed at 120 FPS)
            List<WebSocket> activeClients;
            lock (clientsLock)
            {
                activeClients = connectedClients.ToList();
            }

            var segment = new ArraySegment<byte>(payloadBytes, 0, payloadBytes.Length);
            foreach (var client in activeClients)
            {
                if (client.State == WebSocketState.Open)
                {
                    await client.SendAsync(segment, WebSocketMessageType.Text, true, CancellationToken.None);
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[UDP Error] {ex.Message}");
        }
    }
});

app.Run();

// ----------------------------------------------------
// DATA SCHEMA (Must match Python output exactly)
// ----------------------------------------------------
public class TelemetryPayload
{
    [JsonPropertyName("timestamp")]
    public double Timestamp { get; set; }

    [JsonPropertyName("hands")]
    public List<HandData>? Hands { get; set; }
}

public class HandData
{
    [JsonPropertyName("handedness")]
    public string? Handedness { get; set; }

    [JsonPropertyName("score")]
    public double Score { get; set; }

    [JsonPropertyName("landmarks")]
    public List<float>? Landmarks { get; set; }
}
