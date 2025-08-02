const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Connected clients: userId -> WebSocket
const clients = new Map();
const activeCalls = new Map();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'WebRTC Signaling Server Running',
    connectedClients: clients.size,
    activeCalls: activeCalls.size,
    timestamp: new Date().toISOString()
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Utility functions
function sendToUser(userId, message) {
  const client = clients.get(userId);
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// WebSocket connection handler
wss.on('connection', (ws, request) => {
  let userId = null;
  let heartbeatTimer = null;

  console.log('📱 New WebSocket connection');

  // Start heartbeat
  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(heartbeatTimer);
      }
    }, 30000);
  }

  // Handle pong responses
  ws.on('pong', () => {
    console.log(`💓 Heartbeat pong from user ${userId}`);
  });

  // Handle messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('📨 Received:', message.type, 'from user:', userId);

      switch (message.type) {
        case 'register':
          handleRegister(message);
          break;
        case 'call_request':
          handleCallRequest(message);
          break;
        case 'call_response':
          handleCallResponse(message);
          break;
        case 'end_call':
          handleEndCall(message);
          break;
        case 'offer':
          handleOffer(message);
          break;
        case 'answer':
          handleAnswer(message);
          break;
        case 'ice_candidate':
          handleIceCandidate(message);
          break;
        case 'heartbeat':
          handleHeartbeat(message);
          break;
        default:
          console.log('❓ Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  // Handle connection close
  ws.on('close', () => {
    console.log(`👋 User ${userId} disconnected`);
    if (userId) {
      clients.delete(userId);
      handleUserDisconnect(userId);
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  // Message handlers
  function handleRegister(message) {
    userId = parseInt(message.user_id);
    clients.set(userId, ws);
    startHeartbeat();
    
    ws.send(JSON.stringify({
      type: 'registered',
      user_id: userId,
      timestamp: Date.now()
    }));
    
    console.log(`✅ User ${userId} registered`);
  }

  function handleCallRequest(message) {
    const { call_id, target_user_id, call_type } = message;
    const callerId = userId;

    console.log(`📞 Call request: ${callerId} -> ${target_user_id} (${call_type})`);

    // Store call info
    activeCalls.set(call_id, {
      id: call_id,
      caller_id: callerId,
      target_id: target_user_id,
      call_type,
      status: 'ringing',
      created_at: Date.now()
    });

    // Send to target user
    const sent = sendToUser(target_user_id, {
      type: 'incoming_call',
      call_id,
      caller_id: callerId,
      call_type,
      caller_info: {
        username: `user_${callerId}`,
        full_name: `User ${callerId}`,
        profile_picture: null
      },
      timestamp: Date.now()
    });

    if (!sent) {
      // Target user not online
      ws.send(JSON.stringify({
        type: 'call_failed',
        call_id,
        reason: 'User not online'
      }));
      activeCalls.delete(call_id);
    }
  }

  function handleCallResponse(message) {
    const { call_id, response } = message;
    const call = activeCalls.get(call_id);

    if (!call) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Call not found'
      }));
      return;
    }

    if (response === 'accept') {
      call.status = 'accepted';
      activeCalls.set(call_id, call);

      // Notify caller
      sendToUser(call.caller_id, {
        type: 'call_accepted',
        call_id,
        timestamp: Date.now()
      });

      console.log(`✅ Call ${call_id} accepted`);
    } else if (response === 'reject') {
      // Notify caller
      sendToUser(call.caller_id, {
        type: 'call_rejected',
        call_id,
        timestamp: Date.now()
      });

      activeCalls.delete(call_id);
      console.log(`❌ Call ${call_id} rejected`);
    }
  }

  function handleEndCall(message) {
    const { call_id } = message;
    const call = activeCalls.get(call_id);

    if (call) {
      // Notify both users
      const otherUserId = call.caller_id === userId ? call.target_id : call.caller_id;
      sendToUser(otherUserId, {
        type: 'call_ended',
        call_id,
        timestamp: Date.now()
      });

      activeCalls.delete(call_id);
      console.log(`📵 Call ${call_id} ended by user ${userId}`);
    }
  }

  function handleOffer(message) {
    const { call_id, offer } = message;
    const call = activeCalls.get(call_id);

    if (call) {
      const targetUserId = call.caller_id === userId ? call.target_id : call.caller_id;
      sendToUser(targetUserId, {
        type: 'offer',
        call_id,
        offer,
        timestamp: Date.now()
      });
      console.log(`📄 Offer forwarded for call ${call_id}`);
    }
  }

  function handleAnswer(message) {
    const { call_id, answer } = message;
    const call = activeCalls.get(call_id);

    if (call) {
      const targetUserId = call.caller_id === userId ? call.target_id : call.caller_id;
      sendToUser(targetUserId, {
        type: 'answer',
        call_id,
        answer,
        timestamp: Date.now()
      });
      
      // Mark call as connected
      call.status = 'connected';
      activeCalls.set(call_id, call);
      console.log(`📄 Answer forwarded for call ${call_id}`);
    }
  }

  function handleIceCandidate(message) {
    const { call_id, candidate } = message;
    const call = activeCalls.get(call_id);

    if (call) {
      const targetUserId = call.caller_id === userId ? call.target_id : call.caller_id;
      sendToUser(targetUserId, {
        type: 'ice_candidate',
        call_id,
        candidate,
        timestamp: Date.now()
      });
    }
  }

  function handleHeartbeat(message) {
    ws.send(JSON.stringify({
      type: 'heartbeat_ack',
      timestamp: Date.now()
    }));
  }

  function handleUserDisconnect(disconnectedUserId) {
    // End all calls for this user
    activeCalls.forEach((call, callId) => {
      if (call.caller_id === disconnectedUserId || call.target_id === disconnectedUserId) {
        const otherUserId = call.caller_id === disconnectedUserId ? call.target_id : call.caller_id;
        sendToUser(otherUserId, {
          type: 'call_ended',
          call_id: callId,
          reason: 'User disconnected',
          timestamp: Date.now()
        });
        activeCalls.delete(callId);
      }
    });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 WebRTC Signaling Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});