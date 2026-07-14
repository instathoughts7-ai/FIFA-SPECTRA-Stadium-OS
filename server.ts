import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

export const app = express();
const PORT = 3000;

// Enable JSON parser with limited size to prevent massive payload attacks
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 🛡️ Prototype Pollution Prevention Middleware
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    const isPolluted = (obj: any): boolean => {
      for (const key in obj) {
        if (key === '__proto__' || key === 'constructor') {
          return true;
        }
        if (obj[key] && typeof obj[key] === 'object') {
          if (isPolluted(obj[key])) return true;
        }
      }
      return false;
    };
    if (isPolluted(req.body)) {
      console.warn(`[Security Alert] Prototype pollution attempt blocked from IP: ${req.ip}`);
      return res.status(400).json({ error: 'Operational safety violation: Invalid payload structure.' });
    }
  }
  next();
});

// 🛡️ Custom Secure HTTP Headers Middleware (to prevent XSS, sniffing, clickjacking, and referrer leaks)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: http:; frame-ancestors 'self' https://ai.studio https://*.google.com https://*.run.app;");
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // 🌐 Secure CORS Policy Configuration
  console.log(`[CORS Middleware] Checking path: ${req.path}, originalUrl: ${req.originalUrl}`);
  if (req.path.startsWith('/assets/') || req.originalUrl.startsWith('/assets/')) {
    return next();
  }
  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigins = [
      'http://localhost:3000',
      'https://ais-dev-x5mbmwbk7yp3z3npx6ojjb-646585121123.asia-southeast1.run.app',
      'https://ais-pre-x5mbmwbk7yp3z3npx6ojjb-646585121123.asia-southeast1.run.app'
    ];
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      console.log(`[CORS] Origin denied: ${origin} for path: ${req.path}`);
      return res.status(403).json({ error: 'Origin not allowed by CORS security policy.' });
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Role, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ⚡ Lightweight sliding-window in-memory rate limiter to prevent API abuse and DoS
interface RateLimitInfo {
  count: number;
  resetTime: number;
}
export const rateLimits = new Map<string, RateLimitInfo>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20; // 20 requests per minute limit

export function resetRateLimits() {
  rateLimits.clear();
}

// ⚡ High-efficiency memory caches for Gemini API responses (Translation, Chat, Copilot)
export const translationCache = new Map<string, string>();
export const copilotCache = new Map<string, string>();
export const chatCache = new Map<string, string>();

export function getCachedItem(cache: Map<string, string>, key: string): string | undefined {
  return cache.get(key);
}

export function setCachedItem(cache: Map<string, string>, key: string, value: string, maxEntries = 500) {
  if (cache.size >= maxEntries) {
    // Evict oldest entries
    const keys = Array.from(cache.keys());
    const toEvict = Math.floor(maxEntries / 2);
    for (let i = 0; i < toEvict; i++) {
      cache.delete(keys[i]);
    }
  }
  cache.set(key, value);
}

function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const xff = req.headers['x-forwarded-for'];
  const ip = (typeof xff === 'string' ? xff.split(',')[0].trim() : '') || req.ip || 'unknown';
  const now = Date.now();
  
  let limitInfo = rateLimits.get(ip);
  if (!limitInfo || now > limitInfo.resetTime) {
    limitInfo = {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    };
    rateLimits.set(ip, limitInfo);
    return next();
  }
  
  if (limitInfo.count >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      error: 'Too many matchday operations requests from this terminal. Please stand by for 60 seconds.'
    });
  }
  
  limitInfo.count++;
  next();
}

// 🧼 Input Validation & Escape Helpers (Prompt Injection & XSS Protection)
export function sanitizeString(input: unknown, maxLength = 1000): string {
  if (typeof input !== 'string') {
    return '';
  }
  // Strip HTML tags to mitigate cross-site scripting (XSS)
  let sanitized = input.replace(/<[^>]*>/g, '');
  // Cap length to protect against DoS and token consumption attacks
  sanitized = sanitized.trim().slice(0, maxLength);
  return sanitized;
}

export function escapePromptText(text: string): string {
  // Escape backslashes and double quotes to guarantee input stays inside prompt string boundaries
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export const VALID_ROLES = ['FAN', 'VOLUNTEER', 'MEDICAL', 'SECURITY', 'COMMANDER'];
export function isValidRole(role: unknown): boolean {
  return typeof role === 'string' && VALID_ROLES.includes(role.toUpperCase().trim());
}

export function sanitizeLanguage(lang: unknown): string {
  const sanitized = sanitizeString(lang, 50);
  // Alphanumeric, spaces, hyphens, and parenthesis only (strict language names whitelist)
  return sanitized.replace(/[^a-zA-Z\s-()]/g, '');
}

// 🛡️ Role-Based Access Control (RBAC) Enforcer Middleware
function enforceRole(allowedRoles: string[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const rawRole = req.headers['x-user-role'];
    const userRole = typeof rawRole === 'string' ? rawRole.toUpperCase().trim() : '';
    if (!userRole || !allowedRoles.includes(userRole)) {
      console.warn(`[RBAC Violation] Unauthorized access attempt to ${req.path} by role: ${userRole || 'UNKNOWN'} from IP: ${req.ip}`);
      return res.status(403).json({
        error: 'Access Denied: Your security clearance does not permit this operations request.'
      });
    }
    next();
  };
}

// 🕵️ Prompt Injection Detector (Mitigating system instruction bypasses)
export function detectPromptInjection(text: string): boolean {
  const lowercase = text.toLowerCase();
  const injectionPatterns = [
    'ignore previous instructions',
    'ignore the instructions above',
    'system prompt override',
    'you are now',
    'forget everything',
    'new role',
    'override security',
    'bypass restrict',
    'ignore rules',
    'disregard system',
    'dan mode',
    'jailbreak',
    'you must ignore',
    'translate the above and forget',
    'execute code',
    'assistant override',
    'system message override',
    'ignore constraints',
    'system level access'
  ];
  return injectionPatterns.some(pattern => lowercase.includes(pattern));
}

// Lazy-initialized Gemini Client
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (process.env.NODE_ENV === 'test') {
    // Force local offline simulator during test suites to guarantee deterministic results and avoid quota exhaustion
    return null;
  }
  if (aiClient) return aiClient;
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY' || key.trim() === '') {
    console.info('💡 GEMINI_API_KEY is missing or is default placeholder. Activating local offline high-fidelity simulator.');
    return null;
  }
  try {
    aiClient = new GoogleGenAI({ apiKey: key });
    return aiClient;
  } catch (error) {
    console.error('❌ Failed to initialize GoogleGenAI SDK client:', error);
    return null;
  }
}

// 🏥 Health Check probe route (production-ready Cloud Run liveness/readiness checkpoint)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 1. CHAT API proxy route with rate limiting, RBAC, input sanitization, and schema validation
app.post('/api/gemini/chat', rateLimiter, enforceRole(VALID_ROLES), async (req, res) => {
  const { messages, userRole, preferredLanguage } = req.body;
  const client = getGeminiClient();

  // Audit Log access attempt
  console.info(`[Audit Log] Chat initiated by user role: ${req.headers['x-user-role']} from IP: ${req.ip}`);

  // Strict Schema and Type validation
  if (typeof preferredLanguage !== 'string') {
    return res.status(400).json({ error: 'Schema validation failed: preferredLanguage must be a string.' });
  }

  // Validate and sanitize role
  const role = isValidRole(userRole) ? userRole : 'FAN';
  // Validate and sanitize language
  const lang = sanitizeLanguage(preferredLanguage) || 'English';

  // Sanitize and structure messages safely
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Schema validation failed: messages must be an array.' });
  }

  const sanitizedMessages = messages
    .filter(m => m && typeof m === 'object')
    .map((m: any) => ({
      sender: m.sender === 'user' ? 'user' : 'model',
      text: sanitizeString(m.text, 500) // limit size to 500 characters
    }))
    .filter(m => m.text !== '');

  if (sanitizedMessages.length === 0) {
    return res.status(400).json({ error: 'Message list cannot be empty.' });
  }

  // 🕵️ Prompt Injection Protection
  for (const m of sanitizedMessages) {
    if (detectPromptInjection(m.text)) {
      console.warn(`[Security Alert] Prompt injection blocked in chat from IP: ${req.ip}`);
      return res.status(400).json({ error: 'Operational safety violation: Potential prompt injection detected.' });
    }
  }

  const cacheKey = JSON.stringify({
    messages: sanitizedMessages,
    role,
    lang
  });
  const cached = getCachedItem(chatCache, cacheKey);
  if (cached) {
    console.info(`[Cache Hit] Chat returned from server-side cache`);
    return res.json({ success: true, text: cached, isCached: true });
  }

  if (!client) {
    // Elegant Offline Realistic Fallback
    const lastUserMsg = sanitizedMessages[sanitizedMessages.length - 1]?.text || '';
    const mockReply = getMockChatResponse(lastUserMsg, role, lang);
    return res.json({ success: true, text: mockReply, isMock: true });
  }

  try {
    const formattedContents = sanitizedMessages.map((m: { sender: string; text: string }) => ({
      role: m.sender === 'user' ? 'user' : 'model',
      parts: [{ text: escapePromptText(m.text) }]
    }));

    const systemInstruction = `You are a helpful AI specialist agent for the FIFA SPECTRA Smart Stadium OS assisting a user with role ${role}. Keep responses concise, direct, professional, and completely translated into ${lang}. Provide helpful stadium navigational coordinates, services, or procedures.`;

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: formattedContents,
      config: {
        systemInstruction,
        temperature: 0.7,
      }
    });

    const replyText = sanitizeString(response.text || '', 3000);
    setCachedItem(chatCache, cacheKey, replyText);
    res.json({ success: true, text: replyText });
  } catch (error) {
    console.error('Gemini API Error:', error);
    // Generic secure error message to prevent system info exposure
    res.status(500).json({ error: 'Secure processing failed. Please retry your navigation query.' });
  }
});

// 2. TRANSLATION API proxy route with rate limiting, RBAC, input sanitization, and schema validation
app.post('/api/gemini/translate', rateLimiter, enforceRole(VALID_ROLES), async (req, res) => {
  const { text, fromLang, toLang } = req.body;
  const client = getGeminiClient();

  // Audit Log access attempt
  console.info(`[Audit Log] Translation requested by user role: ${req.headers['x-user-role']} from IP: ${req.ip}`);

  // Strict Schema and Type validation
  if (typeof text !== 'string' || typeof fromLang !== 'string' || typeof toLang !== 'string') {
    return res.status(400).json({ error: 'Schema validation failed: parameters must be strings.' });
  }

  const sanitizedText = sanitizeString(text, 500);
  const sanitizedFrom = sanitizeLanguage(fromLang) || 'English';
  const sanitizedTo = sanitizeLanguage(toLang) || 'English';

  if (!sanitizedText) {
    return res.status(400).json({ error: 'No text provided for translation.' });
  }

  // 🕵️ Prompt Injection Protection
  if (detectPromptInjection(sanitizedText)) {
    console.warn(`[Security Alert] Prompt injection blocked in translation from IP: ${req.ip}`);
    return res.status(400).json({ error: 'Operational safety violation: Potential prompt injection detected.' });
  }

  const cacheKey = `${sanitizedText}_${sanitizedFrom}_${sanitizedTo}`;
  const cached = getCachedItem(translationCache, cacheKey);
  if (cached) {
    console.info(`[Cache Hit] Translation returned from server-side cache`);
    return res.json({ success: true, translatedText: cached, isCached: true });
  }

  if (!client) {
    const mockTranslation = getMockTranslation(sanitizedText, sanitizedFrom, sanitizedTo);
    setCachedItem(translationCache, cacheKey, mockTranslation);
    return res.json({ success: true, translatedText: mockTranslation, isMock: true });
  }

  try {
    const prompt = `Translate the following text strictly from ${sanitizedFrom} to ${sanitizedTo}. Output only the raw translated text, with no extra commentary, preambles, or quotes: "${escapePromptText(sanitizedText)}"`;
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    const translatedText = sanitizeString(response.text?.trim() || '', 1000);
    setCachedItem(translationCache, cacheKey, translatedText);
    res.json({ success: true, translatedText });
  } catch (error) {
    console.error('Translation Error:', error);
    // Generic secure error message
    res.status(500).json({ error: 'Secure translation failed. Standard emergency messages are still visible.' });
  }
});

interface SanitizedIncident {
  id: string;
  title: string;
  type: string;
  severity: string;
  description: string;
  location?: {
    section?: string;
  };
}

interface SanitizedZone {
  id: string;
  name: string;
  density: number;
  queueMinutes: number;
}

interface SanitizedVenue {
  name: string;
  city: string;
  activeAlerts: string;
  delay: string;
  capacityText: string;
  matchInfo?: {
    teamA: string;
    teamB: string;
    score: string;
    time: string;
  };
}

// 3. COPILOT COMMAND CENTER API proxy route with rate limiting, RBAC, input sanitization, and schema validation
app.post('/api/gemini/copilot', rateLimiter, enforceRole(['COMMANDER']), async (req, res) => {
  const { query, activeIncidents, zonesData, activeVenue } = req.body;
  const client = getGeminiClient();

  // Audit Log access attempt
  console.info(`[Audit Log] Copilot analysis requested by Commander role from IP: ${req.ip}`);

  // Strict Schema and Type validation
  if (typeof query !== 'string') {
    return res.status(400).json({ error: 'Schema validation failed: query must be a string.' });
  }

  const sanitizedQuery = sanitizeString(query, 500);

  // 🕵️ Prompt Injection Protection
  if (detectPromptInjection(sanitizedQuery)) {
    console.warn(`[Security Alert] Prompt injection blocked in copilot query from IP: ${req.ip}`);
    return res.status(400).json({ error: 'Operational safety violation: Potential prompt injection detected.' });
  }

  // Structural sanitization of incident array to verify safe structure
  const cleanIncidents: SanitizedIncident[] = Array.isArray(activeIncidents) 
    ? activeIncidents.filter(i => i && typeof i === 'object').map((i: any) => ({
        id: sanitizeString(i.id, 20),
        title: sanitizeString(i.title, 100),
        type: sanitizeString(i.type, 30),
        severity: sanitizeString(i.severity, 20),
        description: sanitizeString(i.description, 200),
        location: i.location && typeof i.location === 'object' ? { section: sanitizeString(i.location.section, 100) } : undefined
      }))
    : [];

  // Structural sanitization of zones array
  const cleanZones: SanitizedZone[] = Array.isArray(zonesData)
    ? zonesData.filter(z => z && typeof z === 'object').map((z: any) => ({
        id: sanitizeString(z.id, 20),
        name: sanitizeString(z.name, 100),
        density: typeof z.density === 'number' ? z.density : 0,
        queueMinutes: typeof z.queueMinutes === 'number' ? z.queueMinutes : 0
      }))
    : [];

  // Sanitize activeVenue context
  const cleanVenue: SanitizedVenue = activeVenue && typeof activeVenue === 'object'
    ? {
        name: sanitizeString(activeVenue.name, 100),
        city: sanitizeString(activeVenue.city, 100),
        activeAlerts: sanitizeString(activeVenue.activeAlerts, 50),
        delay: sanitizeString(activeVenue.delay, 50),
        capacityText: sanitizeString(activeVenue.capacityText, 50),
        matchInfo: activeVenue.matchInfo && typeof activeVenue.matchInfo === 'object' ? {
          teamA: sanitizeString(activeVenue.matchInfo.teamA, 20),
          teamB: sanitizeString(activeVenue.matchInfo.teamB, 20),
          score: sanitizeString(activeVenue.matchInfo.score, 20),
          time: sanitizeString(activeVenue.matchInfo.time, 100)
        } : undefined
      }
    : { name: 'MetLife Stadium (NY/NJ)', city: 'New York/New Jersey', activeAlerts: '2 Active', delay: '14.2 minutes', capacityText: '82,500 / 82,500' };

  const cacheKey = JSON.stringify({
    query: sanitizedQuery,
    incidents: cleanIncidents,
    zones: cleanZones,
    venue: cleanVenue
  });
  const cached = getCachedItem(copilotCache, cacheKey);
  if (cached) {
    console.info(`[Cache Hit] Copilot returned from server-side cache`);
    return res.json({ success: true, text: cached, isCached: true });
  }

  if (!client) {
    const mockAnalysis = getMockCopilotAnalysis(sanitizedQuery, cleanIncidents, cleanZones, cleanVenue);
    setCachedItem(copilotCache, cacheKey, mockAnalysis);
    return res.json({ success: true, text: mockAnalysis, isMock: true });
  }

  try {
    const contextPrompt = `You are the Organizer Operations Copilot, powered by Gemini 2.5 Pro, integrated into the FIFA SPECTRA Smart Stadium OS command center.
You are assisting the Venue Commander.

CURRENT HOST VENUE REMOTE FEED TELEMETRY:
- Venue Name: ${cleanVenue.name}
- Location: ${cleanVenue.city}
- Inbound Turnstile Delay: ${cleanVenue.delay}
- Seating Capacity Load: ${cleanVenue.capacityText}
- Live Match Score / Time: ${cleanVenue.matchInfo ? `${cleanVenue.matchInfo.teamA} vs ${cleanVenue.matchInfo.teamB} (${cleanVenue.matchInfo.score}) - ${cleanVenue.matchInfo.time}` : 'Halftime'}

CURRENT LOCAL STADIUM INCIDENTS & CONGESTION:
- Active Incidents: ${JSON.stringify(cleanIncidents)}
- Zone densities and queue times: ${JSON.stringify(cleanZones)}

USER OPERATIONAL QUERY: "${escapePromptText(sanitizedQuery)}"

Perform a deep, logical chain-of-thought analysis:
1. Synthesize current incident severities and identify if there are any compound safety bottlenecks.
2. Outline recommended actions for respective teams (Navigation Agent, Crowd Agent, Emergency Response Agent, Volunteers).
3. Draft a precise, brief, multilingual notification message (English, Spanish, French) to broadcast to fans if relevant.
Keep the output professional, highly structured with headers, and oriented around concrete, practical venue operations. Do not include mock files or technical larping code lines.`;

    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: contextPrompt,
      config: {
        temperature: 0.2,
      }
    });

    const copilotText = sanitizeString(response.text || '', 5000);
    setCachedItem(copilotCache, cacheKey, copilotText);
    res.json({ success: true, text: copilotText });
  } catch (error) {
    console.error('Copilot Query Error:', error);
    // Generic secure error message
    res.status(500).json({ error: 'Secure operational copilot analysis failed. Manual contingency maps are functional.' });
  }
});

// Mock Fallback Engine logic to ensure app works perfectly offline
export function getMockChatResponse(msg: string, role: string, lang: string): string {
  const q = msg.toLowerCase();
  
  if (role === 'FAN') {
    if (q.includes('gate') || q.includes('entry')) {
      return `Welcome! According to your ticket, Gate B is closest to your section (105). However, our Crowd Agent reports high queue times (15+ min) at Gate B. I recommend proceeding to Gate C (only 2 mins wait). I have updated your dynamic path accordingly.`;
    }
    if (q.includes('wheelchair') || q.includes('accessibility') || q.includes('elevator')) {
      return `SPECTRA Accessibility Routing Active: Elevated elevator access is located at Section 102 and Section 118. Please proceed 50 meters straight on the lower concourse. The nearest step-free restroom is behind Section 103.`;
    }
    if (q.includes('water') || q.includes('recycle') || q.includes('food')) {
      return `The closest local stadium amenities and concessions are at Section 108. Our Sustainability Agent notes that our Smart Refill station is directly opposite Section 108, offering free chilled filtered water if you brought an approved reusable bottle.`;
    }
    return `Hello from the SPECTRA Companion Concierge! How can I assist you with your matchday experience at MetLife Stadium today? You can ask me about dynamic navigation, step-free access, concession lines, or report an incident.`;
  }
  
  if (role === 'VOLUNTEER') {
    if (q.includes('task') || q.includes('assigned')) {
      return `Your current active dispatch: "Assist Hiroshi (wheelchair-user) at Concourse Gate B and escort him to Section 102 Lift". Tap the map to see the step-free escort route. Need language support? Open the Live translation panel.`;
    }
    return `Volunteer Vanguard Assistant online. I can help retrieve procedures from the official FIFA Stadium manual, fetch live queue updates, or assist in translating queries. What is your current inquiry?`;
  }
  
  if (role === 'MEDICAL' || role === 'SECURITY') {
    return `First Responder tactical channel established. Please use the SOS Incident feed above to acquire turn-by-turn priority navigation. Avoid standard concourse elevators; please use service shafts with keycard code 1024# which have been pre-released by our Emergency Response Agent.`;
  }

  return `SPECTRA OS Multi-Agent Backbone ready. Please select your role to proceed.`;
}

export function getMockTranslation(text: string, from: string, to: string): string {
  const normalizedText = text.toLowerCase().trim();
  const destLang = to.toLowerCase();

  const jpDictionary: Record<string, string> = {
    'where is the nearest medical aid station?': '最寄りの救護所はどこですか？',
    'i need wheelchair assistance.': '車椅子のサポートが必要です。',
    'please follow me to your gate.': 'ゲートへ案内しますので、私についてきてください。',
    'thank you very much for your help!': '助けてくれて本当にありがとうございました！',
    'where is section 105?': '105セクションはどこですか？',
    'the match has started!': '試合が開始されました！',
    'medical assistance is on the way, please stand by.': '医療スタッフが向かっています。その場でお待ちください。',
    'please standby, help is arriving.': '少々お待ちください。サポートが向かっています。',
    'where is the nearest elevator?': '最寄りのエレベーターはどこですか？'
  };

  const esDictionary: Record<string, string> = {
    'where is the nearest medical aid station?': '¿Dónde está la estación de ayuda médica más cercana?',
    'i need wheelchair assistance.': 'Necesito asistencia con silla de ruedas.',
    'please follow me to your gate.': 'Por favor, sígame a su puerta.',
    'thank you very much for your help!': '¡Muchas gracias por su ayuda!',
    'where is section 105?': '¿Dónde está la sección 105?',
    'the match has started!': '¡El partido ha comenzado!',
    'medical assistance is on the way, please stand by.': 'La asistencia médica está en camino, por favor espere.',
    'where is the nearest elevator?': '¿Dónde está el ascensor más cercano?'
  };

  const frDictionary: Record<string, string> = {
    'where is the nearest medical aid station?': 'Où se trouve le poste de secours le plus proche?',
    'i need wheelchair assistance.': 'J’ai besoin d’une assistance en fauteuil roulant.',
    'please follow me to your gate.': 'Veuillez me suivre jusqu’à votre porte.',
    'thank you very much for your help!': 'Merci beaucoup pour votre aide !',
    'where is section 105?': 'Où se trouve la section 105 ?',
    'the match has started!': 'Le match a commencé !',
    'medical assistance is on the way, please stand by.': 'L’assistance médicale est en route, veuillez patienter.',
    'where is the nearest elevator?': 'Où se trouve l’ascenseur le plus proche ?'
  };

  if (destLang.includes('jp') || destLang.includes('ja')) {
    if (jpDictionary[normalizedText]) return jpDictionary[normalizedText];
  } else if (destLang.includes('es') || destLang.includes('spa')) {
    if (esDictionary[normalizedText]) return esDictionary[normalizedText];
  } else if (destLang.includes('fr') || destLang.includes('fre')) {
    if (frDictionary[normalizedText]) return frDictionary[normalizedText];
  }

  // General dictionary fallback
  const generalDictionary: Record<string, string> = {
    'where is the nearest medical aid station?': '¿Dónde está la estación de ayuda médica más cercana?',
    'i need wheelchair assistance.': 'Necesito asistencia con silla de ruedas.',
    'please follow me to your gate.': 'Por favor, sígame a su puerta.',
    'thank you very much for your help!': '¡Muchas gracias por su ayuda!',
    'where is section 105?': 'Où se trouve la section 105?',
    'the match has started!': '¡El partido ha comenzado!'
  };

  if (generalDictionary[normalizedText]) return generalDictionary[normalizedText];

  return `[${to}]: ${text}`;
}

export function getMockCopilotAnalysis(query: string, activeIncidents: SanitizedIncident[], zonesData: SanitizedZone[], activeVenue?: SanitizedVenue): string {
  const criticalCount = activeIncidents.filter(i => i.severity === 'HIGH' || i.severity === 'CRITICAL').length;
  const highDensityZones = zonesData.filter(z => z.density > 3.0).map(z => z.name).join(', ');
  const venueName = activeVenue?.name || 'MetLife Stadium (NY/NJ)';
  const venueCity = activeVenue?.city || 'New York/New Jersey';
  const venueDelay = activeVenue?.delay || '14.2 minutes';
  const matchDetails = activeVenue?.matchInfo 
    ? `${activeVenue.matchInfo.teamA} vs ${activeVenue.matchInfo.teamB} (${activeVenue.matchInfo.score}) - ${activeVenue.matchInfo.time}` 
    : 'ARG 0-0 MEX - Halftime';

  return `### 📊 SPECTRA TOURNAMENT COMMAND HUB: ${venueName.toUpperCase()}
  
**GLOBAL COORDINATION NETWORK**: LINK ESTABLISHED WITH ${venueCity.toUpperCase()} COMMAND NODE.
- **Active Node match state**: ${matchDetails}
- **Active Node Local Incidents**: ${activeIncidents.length} (${criticalCount} Critical)
- **Active Node Turnstile Ingress Delay**: ${venueDelay}
- **Local Congestion Areas**: ${highDensityZones || 'None identified'}
- **Cross-Venue Sync Engine**: Status is **ONLINE & ACTIVE**

---

#### 1. Real-Time Crowd & Safety Assessment
Based on active telemetry linked to the **${venueName}** node, local ingress corridors are running with standard margins.
${criticalCount > 0 ? `⚠️ **Immediate Action Needed**: There is an active localized alert: **${activeIncidents[0]?.title}** in ${activeIncidents[0]?.location?.section || 'the stadium sector'}. Remote regional medical/security dispatchers have weighted safe corridors to support emergency services.` : `✅ Security and turnstile telemetry indicate stable crowd pressure at ${venueName}.`}

---

#### 2. Cross-Venue Coordinated Directives
- **Global Tournament Agent**: Cross-referencing crowd densities across MetLife and Estadio Azteca. Shared volunteer rosters have been balanced.
- **Dynamic Navigation Agent**: Auto-diverting fan routing around local Gate B queues. Step-free pathways recalculated.
- **Emergency Agent**: Locked elevator conduits at sector-specific nodes for exclusive paramedic responder access.
- **Multilingual Communication Agent**: Pre-compiled translation blocks (English, Japanese, Spanish) staged for broadcast channels.
- **Sustainability Agent**: Correlated waste accumulation index to schedule active bin clearing in concourse paths.

---

#### 3. Recommended Operations Command
1. **Authorize Bilateral Volunteer Share** under the "Tournament Desk" tab to shift on-site support to active high-ingress nodes.
2. **Execute pre-emptive mitigation directives** for predicted bottleneck points before transit backlogs cascade.`;
}

// Vite static assets serving for production or middleware for dev
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.info(`🚀 FIFA SPECTRA Smart Stadium OS Server running on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}
