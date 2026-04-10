import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ------------------------------------------------------------------
// 🔐 ENV CHECK
// ------------------------------------------------------------------
const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("❌ Missing GITHUB_TOKEN in .env");
  process.exit(1);
}

const endpoint = "https://models.github.ai/inference/chat/completions";
const modelName = "openai/gpt-4o";
function parseAIListResponse(text) {
  if (!text) return null;

  console.log("🔍 Raw AI response:", JSON.stringify(text));

  // Clean up: remove markdown code blocks, quotes, newlines
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`/g, "")
    .replace(/\n/g, " ")
    .trim();

  console.log("🔍 Cleaned response:", JSON.stringify(cleaned));

  // Try strict CSV format on first line: 0.7, cavity, medium
  const firstLine = cleaned.split(/[;\n]/)[0].trim();
  const csvMatch = firstLine.split(",").map(t => t.trim());

  if (csvMatch.length >= 3) {
    const prob = parseFloat(csvMatch[0]);
    const disease = csvMatch[1].toLowerCase();
    const severity = csvMatch[2].toLowerCase();

    if (!isNaN(prob)) {
      console.log("✅ CSV parse success:", { prob, disease, severity });
      return {
        probability: Math.min(1, Math.max(0, prob)),
        disease: disease || "unknown",
        severity: severity || "unknown"
      };
    }
  }

  console.log("⚠️ CSV parse failed, trying regex extraction...");

  // Fallback: extract individually via regex
  // Number: matches 0.72, .72, 72%, 72, 1.0, 0
  const numberMatch = cleaned.match(/\b(1\.0|0?\.\d+|\d{1,2}(?:\.\d+)?)\s*%?/);
  // Severity
  const severityMatch = cleaned.match(/\b(low|medium|high|mild|severe|moderate)\b/i);
  // Disease — expanded list
  const diseaseMatch = cleaned.match(
    /\b(cavity|cavities|caries|gum disease|gingivitis|periodontitis|plaque|tartar|decay|tooth decay|infection|abscess|fluorosis|hypocalcification|erosion|fracture|crack|chips?|healthy|normal|no disease)\b/i
  );

  let probability = 0;
  if (numberMatch) {
    let num = parseFloat(numberMatch[1]);
    // If it looks like a percentage (>1), convert to decimal
    if (num > 1) num = num / 100;
    probability = Math.min(1, Math.max(0, num));
  }

  const result = {
    probability,
    disease: diseaseMatch ? diseaseMatch[0].toLowerCase() : "unknown",
    severity: severityMatch ? severityMatch[0].toLowerCase() : "unknown"
  };

  console.log("🔍 Regex parse result:", result);
  return result;
}
// ------------------------------------------------------------------
// 🚀 APP SETUP
// ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "10mb" }));



// ------------------------------------------------------------------
// 🧠 MEMORY STORE
// ------------------------------------------------------------------
const conversations = new Map();

// ------------------------------------------------------------------
// 🦷 IMAGE ANALYSIS FUNCTION
// ------------------------------------------------------------------
const analyzeTeethImage = async (imageBuffer) => {
  try {
    const base64Image = imageBuffer.toString("base64");
    console.log(`📦 Base64 image length: ${base64Image.length} chars`);

    let attempts = 0;
    let parsed = null;
    let raw = null;

    while (attempts < 3 && !parsed) {
      console.log(`🔄 AI attempt ${attempts + 1}...`);

      const response = await axios.post(
        endpoint,
        {
          model: modelName,
          messages: [
            {
              role: "system",
              content: `You are a dental image analysis AI. Examine the provided dental photograph carefully.

MANDATORY OUTPUT FORMAT (exactly one line, comma-separated):
<probability>, <disease_name>, <severity>

WHERE:
- <probability> = decimal 0.0 to 1.0 (how confident you are a dental issue exists)
- <disease_name> = one of: cavity, gum disease, plaque, tartar, tooth decay, gingivitis, periodontitis, healthy, erosion, abscess, fracture
- <severity> = one of: low, medium, high

EXAMPLES OF CORRECT OUTPUT:
0.85, cavity, high
0.30, plaque, low
0.10, healthy, low

DO NOT write anything else. No explanations, no sentences, no extra lines. Just the three values separated by commas.`
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Look at this dental image carefully. Identify any visible dental issues (cavities, gum disease, plaque, decay, etc.) or confirm if the teeth look healthy. Return ONLY the probability, disease name, and severity in CSV format."
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`,
                    detail: "high"
                  }
                }
              ]
            }
          ],
          max_tokens: 100,
          temperature: 0.1
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );

      raw = response?.data?.choices?.[0]?.message?.content?.trim();
      console.log(`🤖 AI attempt ${attempts + 1} raw response:`, JSON.stringify(raw));

      parsed = parseAIListResponse(raw);
      console.log(`🔎 Parsed result (attempt ${attempts + 1}):`, parsed);

      // Only retry if parsing completely failed (returned null)
      // "unknown" disease is a valid result — don't retry it
      if (!parsed) {
        attempts++;
      } else {
        break; // Valid result found
      }
    }

    if (!parsed) {
      console.warn("⚠️ AI failed after all attempts, using fallback");
      return {
        probability: 0,
        disease: "unknown",
        severity: "unknown"
      };
    }

    console.log("✅ Final analysis result:", parsed);
    return parsed;

  } catch (error) {
    const errDetails = error.response?.data || error.message;
    console.error("❌ analyzeTeethImage error:", JSON.stringify(errDetails, null, 2));

    // Log status code for debugging
    if (error.response?.status) {
      console.error("❌ HTTP Status:", error.response.status);
    }

    return {
      probability: 0,
      disease: "error",
      severity: "unknown"
    };
  }
};

// ------------------------------------------------------------------
// 🦷 IMAGE ONLY ROUTE
// ------------------------------------------------------------------
app.post("/predict", async (req, res) => {
  try {
    let image_base64 = req.body.image;

    // ✅ Check image exists
    if (!image_base64) {
      return res.status(400).json({ error: "No image provided" });
    }

    // ✅ Remove data URL prefix if present
    if (image_base64.includes(",")) {
      image_base64 = image_base64.split(",")[1];
    }

    // ✅ Convert safely
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(image_base64, "base64");
    } catch {
      return res.status(400).json({ error: "Invalid base64 image" });
    }

    // ✅ Debug log (very useful)
    console.log("📸 Image received, size:", imageBuffer.length);

    // ✅ Call AI
    const result = await analyzeTeethImage(imageBuffer);

    return res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error("❌ /predict FULL ERROR:", {
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ------------------------------------------------------------------
// 💬 CHAT ROUTE
// ------------------------------------------------------------------
app.post("/chat", async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const convId = conversationId || `conv_${Date.now()}`;

    if (!conversations.has(convId)) {
      conversations.set(convId, []);
    }

    const history = conversations.get(convId);

    const messages = [
      {
        role: "system",
        content: `
You are an AI dentist assistant.

Rules:
- Use previous conversation context
- Never say you lost context
- Give simple, practical advice
- Be confident and helpful
`
      },
      ...history,
      { role: "user", content: message }
    ];

    const response = await axios.post(
      endpoint,
      {
        model: modelName,
        messages,
        temperature: 0.3
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    // Save history
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: reply });

    return res.json({
      conversationId: convId,
      reply
    });

  } catch (err) {
    console.error("❌ /chat error:", err.response?.data || err.message);

    return res.status(500).json({
      error: err.message
    });
  }
});

// ------------------------------------------------------------------
// 🧠 SMART DENTIST (CHAT + IMAGE MEMORY)
// ------------------------------------------------------------------
app.post("/smart-dentist", async (req, res) => {
  try {
    const { message, image, conversationId } = req.body;

    const convId = conversationId || `conv_${Date.now()}`;

    if (!conversations.has(convId)) {
      conversations.set(convId, []);
    }

    const history = conversations.get(convId);

    let analysisResult = null;

    // -------------------------
    // 🦷 Image Analysis
    // -------------------------
    if (image) {
      let img = image;

      if (img.includes(",")) {
        img = img.split(",")[1];
      }

      const buffer = Buffer.from(img, "base64");
      analysisResult = await analyzeTeethImage(buffer);

      // 🔥 STORE IMAGE RESULT IN CHAT MEMORY
      history.push({
        role: "assistant",
        content: `Image Analysis Result: ${analysisResult}`
      });
    }

    // -------------------------
    // 💬 Build Chat
    // -------------------------
    const messages = [
      {
        role: "system",
        content: `
You are an AI dentist assistant.

- Use chat history AND image analysis
- Never say you lost context
- Explain clearly:
  • Problem
  • Severity
  • What to do
`
      },
      ...history,
      {
        role: "user",
        content: message || "Explain my dental condition"
      }
    ];

    const response = await axios.post(
      endpoint,
      {
        model: modelName,
        messages,
        temperature: 0.3
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    const reply = response.data.choices[0].message.content;

    // Save history
    if (message) {
      history.push({ role: "user", content: message });
    }

    history.push({ role: "assistant", content: reply });

    return res.json({
      conversationId: convId,
      analysis: analysisResult,
      reply
    });

  } catch (error) {
    console.error("❌ /smart-dentist error:", error.response?.data || error.message);

    return res.status(500).json({
      error: error.message
    });
  }
});
app.get("/", (req, res) => {
  res.send("✅ API is running");
});

// ------------------------------------------------------------------
// 🚀 START SERVER
// ------------------------------------------------------------------
app.listen(4000, () => {
  console.log("🚀 Server running on: http://localhost:4000/");
});