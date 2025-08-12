// Minimal in-memory rate limiter (per Worker instance)
const rateLimitStore = new Map();
const RATE_LIMIT_CAPACITY = 5; // tokens
const RATE_LIMIT_REFILL_WINDOW_MS = 60_000; // full refill per minute
const RATE_LIMIT_REFILL_RATE_PER_MS = RATE_LIMIT_CAPACITY / RATE_LIMIT_REFILL_WINDOW_MS; // tokens per ms

function checkAndConsumeRateLimit(identifier) {
  if (!identifier) return true; // if unknown, don't block
  const nowMs = Date.now();
  const bucket = rateLimitStore.get(identifier) || {
    tokens: RATE_LIMIT_CAPACITY,
    lastRefillMs: nowMs,
  };
  const elapsedMs = nowMs - bucket.lastRefillMs;
  bucket.tokens = Math.min(
    RATE_LIMIT_CAPACITY,
    bucket.tokens + elapsedMs * RATE_LIMIT_REFILL_RATE_PER_MS
  );
  bucket.lastRefillMs = nowMs;

  if (bucket.tokens < 1) {
    rateLimitStore.set(identifier, bucket);
    return false;
  }

  bucket.tokens -= 1;
  rateLimitStore.set(identifier, bucket);
  return true;
}

// Whitelist helpers
function normalizePhoneNumber(input) {
  return String(input || "").replace(/[^0-9]/g, "");
}

function parseWhitelist(listText) {
  if (!listText) return [];
  return listText
    .split(/[\n,\r\t ,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isAllowedFromNumber(fromNumber, allowedList) {
  if (!allowedList || allowedList.length === 0) return true; // no whitelist configured -> allow all
  const fromNorm = normalizePhoneNumber(fromNumber);
  return allowedList.some((n) => normalizePhoneNumber(n) === fromNorm);
}

// Conversation history helpers
async function getConversationHistory(kv, phoneNumber, maxHistory = 10) {
  try {
    const history = await kv.get(phoneNumber, { type: "json" });
    return Array.isArray(history) ? history.slice(-maxHistory) : [];
  } catch (error) {
    console.error("Error retrieving conversation history:", error);
    return [];
  }
}

async function addToConversationHistory(kv, phoneNumber, userMessage, aiResponse, ttlDays = 7) {
  try {
    const history = await getConversationHistory(kv, phoneNumber);
    
    history.push({
      timestamp: Date.now(),
      userMessage: userMessage,
      aiResponse: aiResponse
    });

    // Keep only the last maxHistory conversations
    const maxHistory = 10;
    if (history.length > maxHistory) {
      history.splice(0, history.length - maxHistory);
    }

    // Store with TTL (7 days default)
    await kv.put(phoneNumber, JSON.stringify(history), {
      expirationTtl: 60 * 60 * 24 * ttlDays
    });

    return true;
  } catch (error) {
    console.error("Error storing conversation history:", error);
    return false;
  }
}

function buildConversationContext(history, maxContextLength = 1000) {
  if (!history || history.length === 0) return "";
  
  const context = history
    .map(entry => `User: ${entry.userMessage}\nAssistant: ${entry.aiResponse}`)
    .join("\n\n");
  
  // Truncate if too long to avoid hitting API limits
  return context.length > maxContextLength 
    ? context.slice(-maxContextLength) + "\n\n[Previous conversation context included]"
    : context;
}

// Gemini response helpers
function extractGeminiText(data) {
  try {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
    return text;
  } catch (_) {
    return "";
  }
}

function extractGeminiBlockReason(data) {
  const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
  return typeof reason === "string" ? reason : "";
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Escape text for safe inclusion in XML
    const xmlEscape = (text) =>
      String(text ?? "").replace(/[<>&'\"]/g, (ch) => ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[ch]);

    const buildTwiml = (message) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${xmlEscape(message)}</Message>\n</Response>`;

    try {
      const formData = await request.formData();
      const userMsg = (formData.get("Body") || "").toString().trim();
      const fromNumber = (formData.get("From") || "").toString();

      // Whitelist enforcement (comma/newline/space-separated list)
      const allowedList = parseWhitelist(
        env.ALLOWED_FROM_NUMBERS || ""
      );
      if (!isAllowedFromNumber(fromNumber, allowedList)) {
        console.warn("Blocked non-whitelisted number:", fromNumber);
        return new Response("Forbidden", { status: 403 });
      }

      // Minimal rate limiting keyed by sender phone number
      const allowed = checkAndConsumeRateLimit(fromNumber || "");
      if (!allowed) {
        const twiml = buildTwiml(
          "You're sending too many messages. Please try again later."
        );
        return new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }

      if (!userMsg) {
        const twiml = buildTwiml("Please send a message to receive a reply.");
        return new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }

      if (!env.GOOGLE_API_KEY) {
        const twiml = buildTwiml(
          "Server is missing authentication."
        );
        return new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }

      // Get conversation history for context
      let conversationContext = "";
      if (env.CONVERSATIONS) {
        const history = await getConversationHistory(env.CONVERSATIONS, fromNumber);
        conversationContext = buildConversationContext(history);
        console.log(`Retrieved ${history.length} previous conversations for ${fromNumber}`);
      }

      // Call Gemini API with a defensive timeout (Twilio requires a quick response)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s

      let answer = "Sorry, I couldn't get a response.";
      try {
        // Build the request with conversation context if available
        const requestBody = {
          contents: [
            {
              role: "user",
              parts: [{ 
                text: conversationContext 
                  ? `Previous conversation:\n${conversationContext}\n\nCurrent message: ${userMsg}`
                  : userMsg 
              }],
            },
          ],
          systemInstruction: {
            role: "system",
            parts: [{ text: "You are a helpful assistant for old people, answer their questions in a way that is easy to understand and succinct. Keep your responses within 160 characters." }],
          },
        };

        const aiResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${env.GOOGLE_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        if (!aiResp.ok) {
          console.error(
            "Gemini API non-OK status:",
            aiResp.status,
            aiResp.statusText
          );
        } else {
          const data = await aiResp.json().catch((err) => {
            console.error("Gemini JSON parse error:", err);
            return null;
          });
          console.log("Gemini API Response:", data);

          const text = extractGeminiText(data);
          console.log("Gemini API text:", text);
          if (text) {
            answer = text;
          } else {
            const reason = extractGeminiBlockReason(data);
            answer = reason
              ? `No text generated (reason: ${reason}).`
              : "Sorry, I couldn't get a response.";
          }
        }
      } catch (err) {
        console.error("Gemini API request failed:", err);
        clearTimeout(timeoutId);
      }

      // Store conversation in KV if available
      if (env.CONVERSATIONS) {
        await addToConversationHistory(env.CONVERSATIONS, fromNumber, userMsg, answer);
        console.log(`Stored conversation for ${fromNumber}`);
      }

      // Optional: keep SMS concise to avoid very long segments
      const MAX_LEN = 1200;
      if (answer.length > MAX_LEN) {
        answer = answer.slice(0, MAX_LEN - 3) + "...";
      }

      const twiml = buildTwiml(answer);
      return new Response(twiml, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    } catch (err) {
      console.error("Unhandled error:", err);
      const twiml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Response>\n  <Message>Unexpected error. Please try again later.</Message>\n</Response>`;
      return new Response(twiml, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
  },
};
