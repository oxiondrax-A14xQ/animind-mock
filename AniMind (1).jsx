import { useState, useRef, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const C = {
  bg: "#edf3fa", card: "#ffffff", blue: "#5b8fc9", blueDark: "#3d6fa0",
  blueLight: "#d6e8f8", blueXLight: "#eef5fc", text: "#1a2a3a",
  textMid: "#4a6275", textLight: "#8ba3b8", border: "#dce8f2",
  green: "#5bbf8f", orange: "#e8935a", red: "#d05a5a", yellow: "#e8c15a",
};

// ── STORAGE HELPERS ──────────────────────────────────────
const MOOD_SCORES = { calm: 5, okay: 3.5, anxious: 2.5, stressed: 2, low: 1 };
const MOOD_EMOJI  = { calm: "😊", okay: "🙂", anxious: "😟", stressed: "😤", low: "😢" };

async function saveMoodEntry(mood) {
  try {
    let history = [];
    try { const r = await window.storage.get("mood:history"); history = JSON.parse(r.value); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const idx = history.findIndex(e => e.date === today);
    const entry = { date: today, mood, score: MOOD_SCORES[mood] ?? 3 };
    if (idx >= 0) history[idx] = entry; else history.push(entry);
    history = history.slice(-60);
    await window.storage.set("mood:history", JSON.stringify(history));
  } catch {}
}

async function loadMoodHistory() {
  try { const r = await window.storage.get("mood:history"); return JSON.parse(r.value); }
  catch { return []; }
}

async function saveJournalEntry(entry) {
  try {
    let entries = [];
    try { const r = await window.storage.get("journal:entries"); entries = JSON.parse(r.value); } catch {}
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx >= 0) entries[idx] = entry; else entries.unshift(entry);
    await window.storage.set("journal:entries", JSON.stringify(entries.slice(0, 200)));
    return true;
  } catch { return false; }
}

async function loadJournalEntries() {
  try { const r = await window.storage.get("journal:entries"); return JSON.parse(r.value); }
  catch { return []; }
}

async function deleteJournalEntry(id) {
  try {
    const r = await window.storage.get("journal:entries");
    const entries = JSON.parse(r.value).filter(e => e.id !== id);
    await window.storage.set("journal:entries", JSON.stringify(entries));
  } catch {}
}

// ── CLAUDE API ──────────────────────────────────────────
async function askClaudeStream(messages, systemPrompt, onChunk, onDone, onError) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, stream: true, system: systemPrompt, messages }),
    });
    if (!res.ok || !res.body) throw new Error();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        try {
          const p = JSON.parse(data);
          if (p.type === "content_block_delta" && p.delta?.type === "text_delta") { fullText += p.delta.text; onChunk(fullText); }
        } catch {}
      }
    }
    onDone(fullText || "I'm here with you. Tell me more.");
  } catch { onError("I'm here with you. Tell me more."); }
}

async function askClaude(messages, systemPrompt) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: systemPrompt, messages }),
    });
    const d = await res.json(); return d.content?.[0]?.text || "";
  } catch { return ""; }
}

function buildSystemPrompt(userName, mood, ctx) {
  const tod = new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening";
  return `You are AniMind, a warm empathetic AI mental wellness companion using CBT principles. User: ${userName}, Mood: ${mood||"unknown"}, Time: ${tod}, Context: ${ctx||"first message"}. Validate feelings first. 2-3 sentence replies. Ask one open question. Never diagnose. Encourage professional help for crisis.`;
}

async function summarizeContext(messages) {
  if (messages.length < 12) return null;
  const recent = messages.slice(-6), older = messages.slice(0, -6);
  const transcript = older.map(m => `${m.role === "user" ? "User" : "AniMind"}: ${m.text}`).join("\n");
  const summary = await askClaude([{ role: "user", content: `Summarize in 2-3 sentences focusing on emotional themes:\n${transcript}` }], "Summarize therapy conversations concisely.");
  return { summary, recentMessages: recent };
}

async function generateSuggestions(lastUser, lastAI, mood) {
  const r = await askClaude([{ role: "user", content: `Generate 3 short follow-up messages (max 5 words each) as JSON array. User said: "${lastUser}". AniMind replied: "${lastAI}". Mood: ${mood}` }], "Return only valid JSON array of 3 strings.");
  try { const p = JSON.parse(r.replace(/```json|```/g, "").trim()); return Array.isArray(p) ? p.slice(0,3) : null; } catch { return null; }
}

async function generateInsightsSummary(moodData, themes) {
  const r = await askClaude([{ role: "user", content: `Analyze mood data and return JSON with keys "headline","pattern","recommendation". Mood scores: ${JSON.stringify(moodData)}. Themes: ${themes}` }], "CBT wellness analyst. Return only valid JSON.");
  try { return JSON.parse(r.replace(/```json|```/g, "").trim()); } catch { return null; }
}

async function generateJournalPrompt(type, mood) {
  const r = await askClaude([{ role: "user", content: `Single thoughtful journal prompt for someone feeling "${mood||"reflective"}" doing "${type}" journaling. Max 2 sentences. Return only the prompt.` }], "Create gentle CBT-informed journaling prompts. Return only prompt text.");
  return r.trim();
}

const CRISIS_PATTERNS = [/want(ed)? to (die|end it|hurt myself)/i,/end (my|this) life/i,/kill (my)?self/i,/suicid(al|e)/i,/no (reason|point) (to live|anymore)/i,/can't (go on|take it anymore)/i,/self.?harm/i,/hopeless(ness)?/i,/worthless/i];
const detectCrisis = t => CRISIS_PATTERNS.some(p => p.test(t));
function detectEmotion(t) {
  t = t.toLowerCase();
  if (/overwhelm|stress|pressure|burnout/.test(t)) return "stressed";
  if (/sad|depress|grief|cry|lonely/.test(t)) return "sad";
  if (/anxi|worried|nervous|panic/.test(t)) return "anxious";
  return "neutral";
}

// ── ELLIE ──────────────────────────────────────────────
function Ellie({ size = 60, pose = "normal" }) {
  const bodies = {
    normal: <><ellipse cx="32" cy="42" rx="20" ry="17" fill="#a8c8e0"/><ellipse cx="32" cy="24" rx="16" ry="14" fill="#b8d4e8"/><ellipse cx="16" cy="22" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="48" cy="22" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="16" cy="22" rx="5" ry="7" fill="#f4d4e0"/><ellipse cx="48" cy="22" rx="5" ry="7" fill="#f4d4e0"/><path d="M28,34 Q22,40 24,48 Q25,52 28,50" stroke="#a8c8e0" strokeWidth="5" fill="none" strokeLinecap="round"/><circle cx="26" cy="20" r="3.5" fill="#2a4a6a"/><circle cx="38" cy="20" r="3.5" fill="#2a4a6a"/><circle cx="27" cy="19" r="1.2" fill="white"/><circle cx="39" cy="19" r="1.2" fill="white"/><ellipse cx="21" cy="26" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><ellipse cx="43" cy="26" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><rect x="18" y="55" width="9" height="10" rx="4" fill="#a8c8e0"/><rect x="30" y="55" width="9" height="10" rx="4" fill="#a8c8e0"/></>,
    glasses: <><ellipse cx="32" cy="42" rx="20" ry="17" fill="#a8c8e0"/><ellipse cx="32" cy="24" rx="16" ry="14" fill="#b8d4e8"/><ellipse cx="16" cy="22" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="48" cy="22" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="16" cy="22" rx="5" ry="7" fill="#f4d4e0"/><ellipse cx="48" cy="22" rx="5" ry="7" fill="#f4d4e0"/><path d="M28,34 Q22,40 24,48" stroke="#a8c8e0" strokeWidth="5" fill="none" strokeLinecap="round"/><circle cx="26" cy="20" r="3.5" fill="#2a4a6a"/><circle cx="38" cy="20" r="3.5" fill="#2a4a6a"/><circle cx="27" cy="19" r="1.2" fill="white"/><circle cx="39" cy="19" r="1.2" fill="white"/><ellipse cx="21" cy="26" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><ellipse cx="43" cy="26" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><circle cx="26" cy="20" r="6" fill="none" stroke="#5b8fc9" strokeWidth="1.5"/><circle cx="38" cy="20" r="6" fill="none" stroke="#5b8fc9" strokeWidth="1.5"/><line x1="32" y1="20" x2="34" y2="20" stroke="#5b8fc9" strokeWidth="1.5"/><rect x="18" y="55" width="9" height="10" rx="4" fill="#a8c8e0"/><rect x="30" y="55" width="9" height="10" rx="4" fill="#a8c8e0"/></>,
    meditate: <><ellipse cx="32" cy="44" rx="20" ry="17" fill="#a8c8e0"/><ellipse cx="32" cy="26" rx="16" ry="14" fill="#b8d4e8"/><ellipse cx="16" cy="24" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="48" cy="24" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="16" cy="24" rx="5" ry="7" fill="#f4d4e0"/><ellipse cx="48" cy="24" rx="5" ry="7" fill="#f4d4e0"/><path d="M28,36 Q22,42 24,50" stroke="#a8c8e0" strokeWidth="5" fill="none" strokeLinecap="round"/><path d="M22,22 Q26,19 30,22" stroke="#2a4a6a" strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M34,22 Q38,19 42,22" stroke="#2a4a6a" strokeWidth="2" fill="none" strokeLinecap="round"/><ellipse cx="21" cy="28" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><ellipse cx="43" cy="28" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><ellipse cx="22" cy="60" rx="10" ry="6" fill="#a8c8e0"/><ellipse cx="42" cy="60" rx="10" ry="6" fill="#a8c8e0"/><path d="M14,46 Q8,38 12,32" stroke="#a8c8e0" strokeWidth="6" fill="none" strokeLinecap="round"/><path d="M50,46 Q56,38 52,32" stroke="#a8c8e0" strokeWidth="6" fill="none" strokeLinecap="round"/></>,
    doctor: <><ellipse cx="32" cy="42" rx="20" ry="17" fill="#a8c8e0"/><ellipse cx="32" cy="24" rx="16" ry="14" fill="#b8d4e8"/><ellipse cx="16" cy="22" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="48" cy="22" rx="8" ry="10" fill="#a8c8e0"/><ellipse cx="16" cy="22" rx="5" ry="7" fill="#f4d4e0"/><ellipse cx="48" cy="22" rx="5" ry="7" fill="#f4d4e0"/><path d="M28,34 Q22,40 24,48" stroke="#a8c8e0" strokeWidth="5" fill="none" strokeLinecap="round"/><circle cx="26" cy="20" r="3.5" fill="#2a4a6a"/><circle cx="38" cy="20" r="3.5" fill="#2a4a6a"/><circle cx="27" cy="19" r="1.2" fill="white"/><circle cx="39" cy="19" r="1.2" fill="white"/><ellipse cx="21" cy="26" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><ellipse cx="43" cy="26" rx="4" ry="2.5" fill="#f4a0b0" opacity="0.6"/><rect x="14" y="38" width="36" height="24" rx="6" fill="white" opacity="0.9"/><path d="M28,46 Q24,52 28,56 Q32,60 36,56 Q40,52 36,46" stroke="#5b8fc9" strokeWidth="2" fill="none"/><rect x="18" y="58" width="9" height="8" rx="4" fill="#a8c8e0"/><rect x="37" y="58" width="9" height="8" rx="4" fill="#a8c8e0"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 64 68">{bodies[pose]||bodies.normal}</svg>;
}

function Nav({ active, onNav }) {
  const tabs = [{id:"home",icon:"🏠",label:"Home"},{id:"chat",icon:"💬",label:"Chat"},{id:"exercises",icon:"🌿",label:"Exercises"},{id:"insights",icon:"📊",label:"Insights"},{id:"profile",icon:"👤",label:"Profile"}];
  return (
    <div style={{display:"flex",borderTop:`1px solid ${C.border}`,background:"white",paddingBottom:6,flexShrink:0}}>
      {tabs.map(t=>(
        <button key={t.id} onClick={()=>onNav(t.id)} style={{flex:1,border:"none",background:"transparent",cursor:"pointer",padding:"8px 2px 4px",display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
          <span style={{fontSize:18}}>{t.icon}</span>
          <span style={{fontSize:10,fontFamily:"'Nunito',sans-serif",fontWeight:active===t.id?800:500,color:active===t.id?C.blue:C.textLight}}>{t.label}</span>
          {active===t.id&&<div style={{width:16,height:3,borderRadius:2,background:C.blue}}/>}
        </button>
      ))}
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────
const MOODS = [{id:"calm",label:"Calm",emoji:"😊",col:C.green},{id:"okay",label:"Okay",emoji:"🙂",col:C.blue},{id:"anxious",label:"Anxious",emoji:"😟",col:C.yellow},{id:"stressed",label:"Stressed",emoji:"😤",col:C.orange},{id:"low",label:"Low",emoji:"😢",col:"#8b9bb8"}];
const CBT = {calm:{title:"Keep the momentum!",rec:"5-min mindful journaling",icon:"✨"},okay:{title:"Let's build on this",rec:"Gratitude reflection",icon:"🌱"},anxious:{title:"Let's ground you",rec:"5-4-3-2-1 grounding exercise",icon:"🌿"},stressed:{title:"Looks like today feels stressful",rec:"2-minute breathing reset",icon:"💡"},low:{title:"You're not alone in this",rec:"Gentle body scan + journaling",icon:"🫂"}};

function HomeScreen({ onNav, mood, setMood, moodHistory }) {
  const cbt = CBT[mood];
  const h = new Date().getHours();
  const greet = h<12?"Good morning":h<17?"Good afternoon":"Good evening";
  const chartData = (() => {
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return Array.from({length:7},(_,i)=>{
      const d=new Date(); d.setDate(d.getDate()-(6-i));
      const key=d.toISOString().slice(0,10);
      const entry=moodHistory.find(e=>e.date===key);
      return {d:days[d.getDay()],s:entry?.score??null};
    }).filter(d=>d.s!==null);
  })();

  return (
    <div style={{flex:1,overflowY:"auto",background:C.bg}}>
      <div style={{background:"white",padding:"12px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${C.border}`}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><Ellie size={32}/><span style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:18,color:C.blue}}>AniMind</span></div>
        <div style={{width:36,height:36,borderRadius:"50%",background:C.blueLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>👩</div>
      </div>
      <div style={{padding:"16px 14px",display:"flex",flexDirection:"column",gap:14}}>
        <div>
          <h2 style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:22,color:C.text,margin:0}}>{greet}, Alex</h2>
          <p style={{fontFamily:"'Nunito',sans-serif",color:C.textMid,fontSize:14,margin:"3px 0 0"}}>How are you feeling today?</p>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {MOODS.map(m=>(
            <button key={m.id} onClick={()=>setMood(m.id)} style={{padding:"7px 12px",borderRadius:22,border:"none",cursor:"pointer",background:mood===m.id?m.col:"white",color:mood===m.id?"white":C.textMid,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,boxShadow:"0 2px 8px rgba(60,100,150,0.10)",transition:"all .2s"}}>{m.emoji} {m.label}</button>
          ))}
        </div>
        <p onClick={()=>onNav("chat")} style={{fontFamily:"'Nunito',sans-serif",color:C.blue,fontSize:13,fontWeight:700,cursor:"pointer",margin:"-6px 0 0"}}>Want to talk about it? ›</p>

        <div style={{background:"white",borderRadius:18,padding:"14px 16px",boxShadow:"0 4px 20px rgba(60,100,150,0.12)"}}>
          <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{width:40,height:40,borderRadius:12,background:C.blueXLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{cbt.icon}</div>
            <div style={{flex:1}}>
              <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,color:C.text,fontSize:14,margin:"0 0 3px"}}>{cbt.title}</p>
              <p style={{fontFamily:"'Nunito',sans-serif",color:C.textMid,fontSize:12,margin:"0 0 10px"}}>Recommended: {cbt.rec}</p>
              <button onClick={()=>onNav("journal")} style={{width:"100%",padding:"10px",borderRadius:12,border:"none",cursor:"pointer",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13}}>✍️ Open Journal</button>
            </div>
          </div>
        </div>

        <div style={{background:"white",borderRadius:18,padding:"14px 16px",boxShadow:"0 2px 12px rgba(60,100,150,0.09)"}}>
          {[{icon:"☁️",bg:"#d4e8f8",title:"Breathing",sub:"2-min exercises",nav:"exercises"},{icon:"🧠",bg:"#dde8f8",title:"Thought Challenge",sub:"Reframe negative thoughts",nav:"chat"},{icon:"📝",bg:"#f0e8d8",title:"Journal",sub:"Write what's on your mind",nav:"journal"}].map((t,i)=>(
            <div key={i} onClick={()=>onNav(t.nav)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0",borderBottom:i<2?`1px solid ${C.border}`:"none",cursor:"pointer"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:36,height:36,borderRadius:10,background:t.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{t.icon}</div>
                <div><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text}}>{t.title}</p><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{t.sub}</p></div>
              </div>
              <span style={{color:C.textLight}}>›</span>
            </div>
          ))}
        </div>

        <div style={{background:"white",borderRadius:18,padding:"14px 16px",boxShadow:"0 2px 12px rgba(60,100,150,0.09)"}}>
          <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:14,color:C.text,margin:"0 0 6px"}}>Your mood this week</p>
          {chartData.length>0?(
            <ResponsiveContainer width="100%" height={72}>
              <LineChart data={chartData} margin={{top:5,right:5,bottom:0,left:-20}}>
                <XAxis dataKey="d" tick={{fontSize:10,fontFamily:"'Nunito',sans-serif",fill:C.textLight}} axisLine={false} tickLine={false}/>
                <Line type="monotone" dataKey="s" stroke={C.orange} strokeWidth={2.5} dot={{fill:C.orange,r:4,strokeWidth:0}} connectNulls/>
              </LineChart>
            </ResponsiveContainer>
          ):(
            <p style={{fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textLight,textAlign:"center",padding:"14px 0"}}>Tap a mood above each day to see your trend here</p>
          )}
          <button onClick={()=>onNav("insights")} style={{width:"100%",padding:"9px",borderRadius:12,border:"none",cursor:"pointer",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,marginTop:8}}>📊 View Insights ›</button>
        </div>

        <div style={{background:"white",borderRadius:18,padding:"12px 16px",display:"flex",alignItems:"center",gap:10,boxShadow:"0 2px 10px rgba(60,100,150,0.08)"}}>
          <div style={{width:34,height:34,borderRadius:10,background:"#d8f0e4",display:"flex",alignItems:"center",justifyContent:"center"}}>🌿</div>
          <p style={{fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textMid,margin:0}}>I'm here if you want to talk about anything today.</p>
        </div>

        {/* Therapist card */}
        <div onClick={()=>onNav("therapist")} style={{background:"linear-gradient(135deg,#eef5fc,#ddeeff)",borderRadius:18,padding:"14px 16px",boxShadow:"0 2px 10px rgba(60,100,150,0.10)",cursor:"pointer",display:"flex",alignItems:"center",gap:12,border:`1px solid ${C.blueLight}`}}>
          <div style={{width:44,height:44,borderRadius:13,background:C.blueLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>👩‍⚕️</div>
          <div style={{flex:1}}>
            <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text}}>Talk to a Therapist</p>
            <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid}}>Browse licensed professionals & book a session</p>
          </div>
          <span style={{color:C.blue,fontSize:18}}>›</span>
        </div>

        {/* Need support now / distress */}
        <div onClick={()=>onNav("distress")} style={{background:"linear-gradient(135deg,#fff0f0,#ffe8e8)",borderRadius:18,padding:"14px 16px",boxShadow:"0 2px 10px rgba(200,80,80,0.10)",cursor:"pointer",display:"flex",alignItems:"center",gap:12,border:"1px solid #f5d0d0"}}>
          <div style={{width:44,height:44,borderRadius:13,background:"#fde0e0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>🤝</div>
          <div style={{flex:1}}>
            <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:"#b84040"}}>Need Support Right Now?</p>
            <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid}}>You don't have to go through this alone</p>
          </div>
          <span style={{color:"#d05a5a",fontSize:18}}>›</span>
        </div>

        <div style={{height:60}}/>
      </div>
      <div style={{position:"sticky",bottom:16,display:"flex",justifyContent:"flex-end",paddingRight:16}}>
        <button onClick={()=>onNav("chat")} style={{width:68,height:68,borderRadius:"50%",border:"none",cursor:"pointer",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",boxShadow:`0 6px 18px ${C.blue}60`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
          <span style={{fontSize:22}}>💬</span>
          <span style={{fontSize:8,fontFamily:"'Nunito',sans-serif",fontWeight:700,textAlign:"center",lineHeight:1.2}}>Talk to AniMind</span>
        </button>
      </div>
    </div>
  );
}

// ── CHAT ──────────────────────────────────────────────
function ChatScreen({ onNav, currentMood }) {
  const [msgs, setMsgs] = useState([{role:"assistant",text:"I'm really glad you reached out.\nYou don't have to go through this alone."}]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [suggestions, setSuggestions] = useState(["Talk about my mood","Try a breathing exercise","Journal prompt"]);
  const [showBreath, setShowBreath] = useState(false);
  const [breathCount, setBreathCount] = useState(4);
  const [breathPhase, setBreathPhase] = useState(0);
  const [breathCycle, setBreathCycle] = useState(0);
  const [sessionCtx, setSessionCtx] = useState("");
  const [crisisCard, setCrisisCard] = useState(false);
  const bottomRef = useRef(null);
  const PHASES = ["Inhale","Hold","Exhale","Hold"];

  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[msgs,loading,streaming]);
  useEffect(()=>{
    if(!showBreath||breathCycle>=4) return;
    const t=setTimeout(()=>{
      if(breathCount>1){setBreathCount(c=>c-1);}
      else{const next=(breathPhase+1)%4;setBreathPhase(next);setBreathCount(4);if(next===0)setBreathCycle(c=>c+1);}
    },1000);
    return()=>clearTimeout(t);
  },[showBreath,breathCount,breathPhase,breathCycle]);

  async function send(text) {
    const t=(text||input).trim(); if(!t||loading||streaming) return;
    setInput("");
    if(detectCrisis(t)) setCrisisCard(true);
    const emotion=detectEmotion(t);
    const updated=[...msgs,{role:"user",text:t}];
    setMsgs(updated); setLoading(true);
    let ctx=updated;
    if(updated.length>12){const r=await summarizeContext(updated);if(r){setSessionCtx(r.summary);ctx=r.recentMessages;}}
    const sys=buildSystemPrompt("Alex",currentMood,sessionCtx);
    const api=ctx.map(m=>({role:m.role==="user"?"user":"assistant",content:m.text}));
    setMsgs(prev=>[...prev,{role:"assistant",text:"",streaming:true}]);
    setLoading(false); setStreaming(true);
    let finalReply="";
    askClaudeStream(api,sys,
      (partial)=>setMsgs(prev=>{const c=[...prev];if(c[c.length-1]?.streaming)c[c.length-1]={role:"assistant",text:partial,streaming:true};return c;}),
      async(full)=>{
        finalReply=full;
        const extras=(emotion==="stressed"||emotion==="anxious")?[{role:"suggestion",text:"Would you like a short pause?\nTake a 30-second breathing reset"}]:[];
        setMsgs(prev=>{const c=[...prev];if(c[c.length-1]?.streaming)c[c.length-1]={role:"assistant",text:full};return[...c,...extras];});
        setStreaming(false);
        generateSuggestions(t,finalReply,currentMood).then(s=>{if(s)setSuggestions(s);});
      },
      (err)=>{setMsgs(prev=>{const c=[...prev];if(c[c.length-1]?.streaming)c[c.length-1]={role:"assistant",text:err};return c;});setStreaming(false);}
    );
  }

  if(showBreath) return(
    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"linear-gradient(180deg,#d8eaf8,#eef5fc)",padding:24}}>
      <Ellie size={80} pose="meditate"/>
      <div style={{marginTop:20,marginBottom:24,width:130,height:130,borderRadius:"50%",border:`3px solid ${C.blue}`,background:breathPhase===0?`radial-gradient(circle, ${C.blueLight} ${breathCount*20}%, white 100%)`:breathPhase===2?`radial-gradient(circle, white ${breathCount*20}%, ${C.blueLight} 100%)`:C.blueXLight,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",boxShadow:`0 0 40px ${C.blue}30`,transition:"background 1s ease"}}>
        <span style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:34,color:C.blue}}>{breathCount}</span>
        <span style={{fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textMid}}>{breathCycle<4?PHASES[breathPhase]:"Done!"}</span>
      </div>
      {breathCycle<4?<p style={{fontFamily:"'Nunito',sans-serif",color:C.textMid,fontSize:14,margin:"0 0 24px"}}>Cycle {breathCycle+1} of 4 — Box Breathing</p>:<p style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:16,color:C.text,margin:"0 0 24px"}}>Well done! 🎉</p>}
      <button onClick={()=>{setShowBreath(false);setBreathCycle(0);setBreathPhase(0);setBreathCount(4);}} style={{padding:"11px 28px",borderRadius:14,border:`1px solid ${C.border}`,background:"white",color:C.textMid,fontFamily:"'Nunito',sans-serif",fontWeight:600,cursor:"pointer"}}>← Back to Chat</button>
    </div>
  );

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:C.bg}}>
      <div style={{background:"white",padding:"10px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.border}`}}>
        <button onClick={()=>onNav("home")} style={{background:"none",border:"none",color:C.blue,fontSize:20,cursor:"pointer"}}>←</button>
        <Ellie size={38}/>
        <div style={{flex:1}}>
          <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:15,color:C.text}}>AniMind</p>
          <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:streaming?C.green:C.textLight}}>{streaming?"✦ Thinking...":"I'm here with you"}</p>
        </div>
      </div>
      <div style={{background:C.blueXLight,padding:"7px",textAlign:"center",borderBottom:`1px solid ${C.border}`}}>
        <span style={{fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid}}>Mood today: <strong style={{color:C.blue}}>{currentMood?currentMood.charAt(0).toUpperCase()+currentMood.slice(1):"Not set"}</strong></span>
      </div>
      {crisisCard&&(
        <div style={{background:"#fff5f5",borderBottom:"2px solid #f0c0c0",padding:"12px 14px",display:"flex",alignItems:"flex-start",gap:10}}>
          <span style={{fontSize:22}}>🤝</span>
          <div style={{flex:1}}>
            <p style={{margin:"0 0 3px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:13,color:"#c04040"}}>You're not alone right now</p>
            <p style={{margin:"0 0 7px",fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid}}>If you're in crisis, please reach out to a real person.</p>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              <a href="tel:988" style={{padding:"5px 10px",borderRadius:8,background:"#d05a5a",color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:11,textDecoration:"none"}}>📞 Call 988</a>
              <a href="sms:741741&body=HELLO" style={{padding:"5px 10px",borderRadius:8,background:C.blue,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:11,textDecoration:"none"}}>💬 Text 741741</a>
              <button onClick={()=>{setCrisisCard(false);onNav("therapist");}} style={{padding:"5px 10px",borderRadius:8,border:"none",background:C.green,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:11,cursor:"pointer"}}>Find Therapist</button>
            </div>
          </div>
          <button onClick={()=>setCrisisCard(false)} style={{background:"none",border:"none",color:C.textLight,fontSize:16,cursor:"pointer",flexShrink:0}}>×</button>
        </div>
      )}
      <div style={{flex:1,overflowY:"auto",padding:"14px",display:"flex",flexDirection:"column",gap:10,background:"linear-gradient(180deg,#edf3fa,#e4eef8)"}}>
        {msgs.map((m,i)=>(
          <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
            {m.role==="suggestion"?(
              <div style={{background:"white",borderRadius:16,padding:"12px 14px",maxWidth:"82%",boxShadow:"0 2px 10px rgba(60,100,150,0.1)",border:`1px solid ${C.border}`}}>
                <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text,margin:"0 0 3px"}}>{m.text.split("\n")[0]}</p>
                <p style={{fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textLight,margin:"0 0 9px"}}>{m.text.split("\n")[1]}</p>
                <button onClick={()=>setShowBreath(true)} style={{padding:"8px 18px",borderRadius:10,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>Start breathing</button>
              </div>
            ):(
              <div style={{maxWidth:"78%",padding:"11px 14px",borderRadius:m.role==="user"?"16px 16px 3px 16px":"16px 16px 16px 3px",background:m.role==="user"?`linear-gradient(135deg,${C.blue},${C.blueDark})`:"white",color:m.role==="user"?"white":C.text,fontFamily:"'Nunito',sans-serif",fontSize:13,lineHeight:1.6,boxShadow:"0 2px 8px rgba(60,100,150,0.10)",whiteSpace:"pre-line"}}>
                {m.text}
                {m.streaming&&m.text.length===0&&<span style={{display:"flex",gap:4}}>{[0,1,2].map(j=><span key={j} style={{width:7,height:7,borderRadius:"50%",background:C.blue,display:"inline-block",animation:`bounce 1.2s ease ${j*0.2}s infinite`}}/>)}</span>}
                {m.streaming&&m.text.length>0&&<span style={{display:"inline-block",width:2,height:"1em",background:C.blue,marginLeft:2,verticalAlign:"text-bottom",animation:"blink 0.8s step-end infinite"}}/>}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef}/>
      </div>
      <div style={{padding:"6px 14px",background:"white",borderTop:`1px solid ${C.border}`,display:"flex",gap:6,overflowX:"auto"}}>
        {suggestions.map(c=><button key={c} onClick={()=>send(c)} style={{padding:"5px 11px",borderRadius:18,border:`1px solid ${C.border}`,background:C.blueXLight,color:C.blue,fontFamily:"'Nunito',sans-serif",fontWeight:600,fontSize:11,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>{c}</button>)}
      </div>
      <div style={{padding:"8px 14px 10px",background:"white",display:"flex",gap:8,alignItems:"center"}}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()} placeholder="Type what's on your mind..." style={{flex:1,padding:"10px 14px",borderRadius:22,border:`1px solid ${C.border}`,background:C.bg,fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.text,outline:"none"}}/>
        <button onClick={()=>send()} disabled={streaming||loading} style={{width:38,height:38,borderRadius:"50%",border:"none",cursor:input.trim()&&!streaming?"pointer":"default",background:input.trim()&&!streaming?`linear-gradient(135deg,${C.blue},${C.blueDark})`:C.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,color:input.trim()&&!streaming?"white":C.textLight}}>↑</button>
      </div>
    </div>
  );
}

// ── JOURNAL ──────────────────────────────────────────────
const JOURNAL_TYPES = [
  {id:"free",label:"Free Write",icon:"📝",bg:"#f0e8d8"},
  {id:"gratitude",label:"Gratitude",icon:"💚",bg:"#d8f0e4"},
  {id:"cbt",label:"Thought Record",icon:"🧠",bg:"#dde8f8"},
  {id:"reflection",label:"Daily Reflection",icon:"🌙",bg:"#e8d8f0"},
];

function JournalScreen({ onNav, currentMood }) {
  const [view, setView] = useState("list");
  const [entries, setEntries] = useState([]);
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [selType, setSelType] = useState("free");
  const [filterType, setFilterType] = useState("all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [promptLoading, setPromptLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(()=>{ loadJournalEntries().then(e=>{setEntries(e);setLoadingEntries(false);}); },[]);

  useEffect(()=>{
    if(view==="write"){setTitle("");setBody("");setSaved(false);setAiPrompt("");loadPrompt(selType);}
  },[view,selType]);

  async function loadPrompt(type){
    setPromptLoading(true);
    const p=await generateJournalPrompt(type,currentMood);
    setAiPrompt(p||JOURNAL_TYPES.find(t=>t.id===type)?.prompt||"Write freely…");
    setPromptLoading(false);
  }

  async function handleSave(){
    if(!body.trim()) return;
    setSaving(true);
    const jt=JOURNAL_TYPES.find(t=>t.id===selType);
    const entry={id:Date.now().toString(),date:new Date().toISOString(),type:selType,typeLabel:jt.label,typeIcon:jt.icon,title:title.trim()||jt.label,body:body.trim(),mood:currentMood};
    const ok=await saveJournalEntry(entry);
    if(ok){setEntries(prev=>[entry,...prev.filter(e=>e.id!==entry.id)]);setSaved(true);}
    setSaving(false);
  }

  async function handleDelete(id){
    await deleteJournalEntry(id);
    setEntries(prev=>prev.filter(e=>e.id!==id));
    setDeleteConfirm(null);
    if(view==="read") setView("list");
  }

  const fmtDate=iso=>new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
  const fmtTime=iso=>new Date(iso).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});

  // READ
  if(view==="read"&&selectedEntry) return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:C.bg,position:"relative"}}>
      <div style={{background:"white",padding:"12px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.border}`}}>
        <button onClick={()=>setView("list")} style={{background:"none",border:"none",color:C.blue,fontSize:20,cursor:"pointer"}}>←</button>
        <div style={{flex:1}}>
          <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:15,color:C.text}}>{selectedEntry.title}</p>
          <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{fmtDate(selectedEntry.date)} · {fmtTime(selectedEntry.date)}</p>
        </div>
        <button onClick={()=>setDeleteConfirm(selectedEntry.id)} style={{background:"none",border:"none",color:C.textLight,fontSize:18,cursor:"pointer"}}>🗑️</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"16px"}}>
        <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
          <span style={{padding:"4px 10px",borderRadius:12,background:JOURNAL_TYPES.find(t=>t.id===selectedEntry.type)?.bg||C.blueXLight,fontFamily:"'Nunito',sans-serif",fontSize:12,fontWeight:700,color:C.text}}>{selectedEntry.typeIcon} {selectedEntry.typeLabel}</span>
          {selectedEntry.mood&&<span style={{padding:"4px 10px",borderRadius:12,background:C.blueXLight,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.blue}}>{MOOD_EMOJI[selectedEntry.mood]} {selectedEntry.mood}</span>}
        </div>
        <div style={{background:"white",borderRadius:16,padding:"16px",boxShadow:"0 2px 10px rgba(60,100,150,0.09)"}}>
          <p style={{fontFamily:"'Nunito',sans-serif",fontSize:14,color:C.text,margin:0,lineHeight:1.7,whiteSpace:"pre-wrap"}}>{selectedEntry.body}</p>
        </div>
      </div>
      {deleteConfirm&&(
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:10}}>
          <div style={{background:"white",borderRadius:20,padding:24,margin:24,textAlign:"center"}}>
            <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:16,color:C.text,margin:"0 0 8px"}}>Delete this entry?</p>
            <p style={{fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textMid,margin:"0 0 18px"}}>This can't be undone.</p>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setDeleteConfirm(null)} style={{flex:1,padding:"10px",borderRadius:12,border:`1px solid ${C.border}`,background:"white",color:C.textMid,fontFamily:"'Nunito',sans-serif",fontWeight:700,cursor:"pointer"}}>Cancel</button>
              <button onClick={()=>handleDelete(deleteConfirm)} style={{flex:1,padding:"10px",borderRadius:12,border:"none",background:C.red,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,cursor:"pointer"}}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // WRITE
  if(view==="write") return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:C.bg}}>
      <div style={{background:"white",padding:"12px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.border}`}}>
        <button onClick={()=>setView("list")} style={{background:"none",border:"none",color:C.blue,fontSize:20,cursor:"pointer"}}>←</button>
        <p style={{flex:1,margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:16,color:C.text}}>New Entry</p>
        <button onClick={handleSave} disabled={!body.trim()||saving} style={{padding:"7px 16px",borderRadius:12,border:"none",cursor:body.trim()&&!saving?"pointer":"default",background:body.trim()&&!saving?(saved?C.green:`linear-gradient(135deg,${C.blue},${C.blueDark})`):C.border,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13}}>
          {saving?"Saving…":saved?"✓ Saved":"Save"}
        </button>
      </div>
      <div style={{background:"white",padding:"10px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:8,overflowX:"auto"}}>
        {JOURNAL_TYPES.map(t=>(
          <button key={t.id} onClick={()=>setSelType(t.id)} style={{padding:"6px 12px",borderRadius:18,border:"none",cursor:"pointer",background:selType===t.id?C.blue:C.blueXLight,color:selType===t.id?"white":C.textMid,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:12,whiteSpace:"nowrap",flexShrink:0}}>{t.icon} {t.label}</button>
        ))}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"14px",display:"flex",flexDirection:"column",gap:12}}>
        <div style={{background:`linear-gradient(135deg,${C.blueXLight},white)`,borderRadius:14,padding:"12px 14px",border:`1px solid ${C.blueLight}`}}>
          <p style={{margin:"0 0 4px",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:12,color:C.blue}}>✦ Writing prompt</p>
          {promptLoading?(
            <div style={{display:"flex",gap:4,padding:"4px 0"}}>{[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:C.blue,animation:`bounce 1.2s ease ${i*0.2}s infinite`}}/>)}</div>
          ):(
            <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textMid,lineHeight:1.5}}>{aiPrompt}</p>
          )}
          <button onClick={()=>loadPrompt(selType)} style={{marginTop:7,padding:"4px 10px",borderRadius:10,border:`1px solid ${C.border}`,background:"white",color:C.blue,fontFamily:"'Nunito',sans-serif",fontWeight:600,fontSize:11,cursor:"pointer"}}>↻ New prompt</button>
        </div>
        <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Title (optional)" style={{padding:"10px 14px",borderRadius:12,border:`1px solid ${C.border}`,background:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:15,color:C.text,outline:"none"}}/>
        <textarea value={body} onChange={e=>{setBody(e.target.value);setSaved(false);}} placeholder="Start writing…" rows={10} style={{padding:"12px 14px",borderRadius:12,border:`1px solid ${C.border}`,background:"white",fontFamily:"'Nunito',sans-serif",fontSize:14,color:C.text,outline:"none",resize:"none",lineHeight:1.7}}/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{body.trim().split(/\s+/).filter(Boolean).length} words</span>
          {saved&&<span style={{fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.green,fontWeight:700}}>✓ Entry saved</span>}
        </div>
      </div>
    </div>
  );

  // LIST
  const filtered=entries.filter(e=>filterType==="all"||e.type===filterType);
  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:C.bg}}>
      <div style={{background:"white",padding:"12px 16px 10px",display:"flex",alignItems:"center",gap:12,borderBottom:`1px solid ${C.border}`}}>
        <button onClick={()=>onNav("exercises")} style={{background:"none",border:"none",color:C.blue,fontSize:20,cursor:"pointer"}}>←</button>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:20,color:C.text}}>My Journal</h2>
          <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textLight}}>{entries.length} {entries.length===1?"entry":"entries"}</p>
        </div>
        <button onClick={()=>setView("write")} style={{padding:"7px 14px",borderRadius:12,border:"none",cursor:"pointer",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13}}>+ New</button>
      </div>
      <div style={{background:"white",padding:"8px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:6,overflowX:"auto"}}>
        {[{id:"all",label:"All",icon:"📚"},...JOURNAL_TYPES].map(t=>(
          <button key={t.id} onClick={()=>setFilterType(t.id)} style={{padding:"5px 11px",borderRadius:16,border:"none",cursor:"pointer",background:filterType===t.id?C.blue:C.blueXLight,color:filterType===t.id?"white":C.textMid,fontFamily:"'Nunito',sans-serif",fontWeight:600,fontSize:11,whiteSpace:"nowrap",flexShrink:0}}>{t.icon} {t.label}</button>
        ))}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"12px 14px"}}>
        {loadingEntries?(
          <div style={{display:"flex",justifyContent:"center",paddingTop:40}}><div style={{display:"flex",gap:5}}>{[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:C.blue,animation:`bounce 1.2s ease ${i*0.2}s infinite`}}/>)}</div></div>
        ):filtered.length===0?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",paddingTop:48,gap:12}}>
            <Ellie size={80}/>
            <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:16,color:C.text,margin:0}}>No entries yet</p>
            <p style={{fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textMid,margin:0,textAlign:"center"}}>Start writing to capture your thoughts and feelings.</p>
            <button onClick={()=>setView("write")} style={{padding:"10px 22px",borderRadius:14,border:"none",cursor:"pointer",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:14}}>Write first entry</button>
          </div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {filtered.map(entry=>{
              const jt=JOURNAL_TYPES.find(t=>t.id===entry.type);
              return(
                <div key={entry.id} onClick={()=>{setSelectedEntry(entry);setView("read");}} style={{background:"white",borderRadius:16,padding:"14px",boxShadow:"0 2px 10px rgba(60,100,150,0.09)",cursor:"pointer",borderLeft:`4px solid ${jt?.bg||C.blueLight}`}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:5}}>
                    <div style={{flex:1}}>
                      <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text}}>{entry.title}</p>
                      <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{fmtDate(entry.date)}</span>
                        <span style={{fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.blue}}>{jt?.icon} {entry.typeLabel}</span>
                        {entry.mood&&<span style={{fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{MOOD_EMOJI[entry.mood]}</span>}
                      </div>
                    </div>
                    <span style={{color:C.textLight,fontSize:14}}>›</span>
                  </div>
                  <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid,lineHeight:1.5,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{entry.body}</p>
                </div>
              );
            })}
            <div style={{height:20}}/>
          </div>
        )}
      </div>
    </div>
  );
}

// ── EXERCISES ──────────────────────────────────────────────
function ExercisesScreen({ onNav }) {
  return(
    <div style={{flex:1,overflowY:"auto",background:C.bg}}>
      <div style={{background:"white",padding:"12px 16px 10px",display:"flex",alignItems:"center",gap:12,borderBottom:`1px solid ${C.border}`}}>
        <Ellie size={50} pose="meditate"/>
        <div><h2 style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:20,color:C.text}}>Exercises</h2><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textLight}}>Support your mental wellness</p></div>
      </div>
      <div style={{padding:"14px"}}>
        <div style={{background:"white",borderRadius:22,padding:"9px 14px",display:"flex",alignItems:"center",gap:8,boxShadow:"0 2px 8px rgba(60,100,150,0.08)",marginBottom:16,border:`1px solid ${C.border}`}}>
          <span>🔍</span><input placeholder="Search exercises..." style={{border:"none",background:"transparent",fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.text,outline:"none",flex:1}}/>
        </div>
        <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text,margin:"0 0 8px"}}>Quick Sessions</p>
        <div style={{background:"white",borderRadius:16,boxShadow:"0 2px 10px rgba(60,100,150,0.09)",marginBottom:16,overflow:"hidden"}}>
          {[{icon:"☁️",bg:"#d4e8f8",t:"Breathing Reset",s:"2-minute guided breathing exercise",nav:"chat"},{icon:"🧠",bg:"#dde8f8",t:"Thought Challenge",s:"Reframe negative thoughts",nav:"chat"},{icon:"🌸",bg:"#e8d8f0",t:"Tension Release",s:"Relax your body with a mindful release",nav:"chat"}].map((e,i)=>(
            <div key={i} onClick={()=>onNav(e.nav)} style={{display:"flex",alignItems:"center",padding:"12px 14px",borderBottom:i<2?`1px solid ${C.border}`:"none",cursor:"pointer"}}>
              <div style={{width:40,height:40,borderRadius:12,background:e.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,marginRight:10}}>{e.icon}</div>
              <div style={{flex:1}}><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text}}>{e.t}</p><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{e.s}</p></div>
              <span style={{color:C.textLight}}>›</span>
            </div>
          ))}
        </div>
        <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text,margin:"0 0 8px"}}>Journaling</p>
        <div style={{background:"white",borderRadius:16,boxShadow:"0 2px 10px rgba(60,100,150,0.09)",marginBottom:16,overflow:"hidden"}}>
          {[{icon:"💚",bg:"#d8f0e4",t:"Gratitude Journal",s:"Reflect on things you're grateful for"},{icon:"📝",bg:"#f0e8d8",t:"Free Write",s:"Write whatever's on your mind"},{icon:"🧠",bg:"#dde8f8",t:"Thought Record",s:"CBT-style thought journaling"},{icon:"🌙",bg:"#e8d8f0",t:"Daily Reflection",s:"End-of-day check-in"}].map((e,i,arr)=>(
            <div key={i} onClick={()=>onNav("journal")} style={{display:"flex",alignItems:"center",padding:"12px 14px",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none",cursor:"pointer"}}>
              <div style={{width:40,height:40,borderRadius:12,background:e.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,marginRight:10}}>{e.icon}</div>
              <div style={{flex:1}}><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text}}>{e.t}</p><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{e.s}</p></div>
              <span style={{color:C.textLight}}>›</span>
            </div>
          ))}
        </div>
        <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text,margin:"0 0 8px"}}>Exercise Highlights</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
          {[{t:"Tension Release",content:<Ellie size={72} pose="meditate"/>},{t:"Thinking Traps",sub:"Identify and challenge cognitive distortions.",content:<span style={{fontSize:48}}>💡</span>}].map((h,i)=>(
            <div key={i} style={{borderRadius:16,padding:"12px",background:"linear-gradient(180deg,#d8eaf8,#c0d8f0)",cursor:"pointer",minHeight:130,overflow:"hidden"}}>
              <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:13,color:C.text}}>{h.t}</p>
              {h.sub&&<p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textMid}}>{h.sub}</p>}
              <div style={{display:"flex",justifyContent:"center",marginTop:4}}>{h.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── INSIGHTS ──────────────────────────────────────────────
function InsightsScreen({ currentMood, moodHistory }) {
  const [aiInsight, setAiInsight] = useState(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  const chartData = (() => {
    const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return Array.from({length:7},(_,i)=>{
      const d=new Date(); d.setDate(d.getDate()-(6-i));
      const key=d.toISOString().slice(0,10);
      const entry=moodHistory.find(e=>e.date===key);
      return {d:days[d.getDay()],s:entry?.score??null,mood:entry?.mood};
    });
  })();
  const filled=chartData.filter(d=>d.s!==null);
  const avg=filled.length?(filled.reduce((s,d)=>s+d.s,0)/filled.length).toFixed(1):null;
  const trend=filled.length>=2?filled[filled.length-1].s-filled[0].s:0;

  useEffect(()=>{
    if(moodHistory.length<2||aiInsight||loadingInsight) return;
    setLoadingInsight(true);
    const map={};
    moodHistory.slice(-7).forEach(e=>{map[e.date]=e.score;});
    const themes=moodHistory.slice(-7).map(e=>e.mood).join(", ");
    generateInsightsSummary(map,themes+`, current mood: ${currentMood}`).then(r=>{setAiInsight(r);setLoadingInsight(false);});
  },[moodHistory]);

  return(
    <div style={{flex:1,overflowY:"auto",background:C.bg}}>
      <div style={{background:"white",padding:"12px 16px 10px",display:"flex",alignItems:"center",gap:12,borderBottom:`1px solid ${C.border}`}}>
        <Ellie size={50} pose="glasses"/>
        <div><h2 style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:20,color:C.text}}>Insights</h2><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textLight}}>Understanding your emotional patterns</p></div>
      </div>
      <div style={{padding:"14px"}}>
        {filled.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            {[{label:"Days tracked",value:filled.length,icon:"📅"},{label:"Avg mood",value:avg?`${avg}/5`:"—",icon:"📊"},{label:"This week",value:trend>0.3?"↑ Better":trend<-0.3?"↓ Dipped":"→ Stable",icon:trend>0.3?"🌟":trend<-0.3?"💙":"🌿"}].map((s,i)=>(
              <div key={i} style={{background:"white",borderRadius:14,padding:"10px",textAlign:"center",boxShadow:"0 2px 8px rgba(60,100,150,0.09)"}}>
                <p style={{margin:"0 0 2px",fontSize:18}}>{s.icon}</p>
                <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:15,color:C.text}}>{s.value}</p>
                <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:10,color:C.textLight}}>{s.label}</p>
              </div>
            ))}
          </div>
        )}
        <div style={{background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,borderRadius:18,padding:"16px",marginBottom:14,color:"white",boxShadow:`0 6px 20px ${C.blue}40`}}>
          <p style={{margin:"0 0 6px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:13,opacity:0.85}}>✦ Your AI Weekly Insight</p>
          {loadingInsight?(
            <div style={{display:"flex",gap:5,padding:"6px 0"}}>{[0,1,2].map(i=><div key={i} style={{width:7,height:7,borderRadius:"50%",background:"white",opacity:0.7,animation:`bounce 1.2s ease ${i*0.2}s infinite`}}/>)}</div>
          ):aiInsight?(
            <>
              <p style={{margin:"0 0 6px",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:14,lineHeight:1.4}}>{aiInsight.headline}</p>
              <p style={{margin:"0 0 8px",fontFamily:"'Nunito',sans-serif",fontSize:12,opacity:0.9,lineHeight:1.5}}>{aiInsight.pattern}</p>
              <div style={{background:"rgba(255,255,255,0.15)",borderRadius:10,padding:"8px 10px"}}><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:12,fontWeight:700}}>💡 {aiInsight.recommendation}</p></div>
            </>
          ):(
            <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:13,opacity:0.85}}>{moodHistory.length<2?"Log your mood for a few days to unlock your personalized AI insight.":"Your weekly patterns will appear here."}</p>
          )}
        </div>
        <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text,margin:"0 0 8px"}}>Mood Trend — Last 7 Days</p>
        <div style={{background:"white",borderRadius:16,padding:"14px",boxShadow:"0 2px 10px rgba(60,100,150,0.09)",marginBottom:14}}>
          {filled.length>0?(
            <>
              <div style={{display:"flex",justifyContent:"space-around",marginBottom:4}}>
                {chartData.map((d,i)=><span key={i} style={{fontSize:14,minWidth:28,textAlign:"center"}}>{d.mood?MOOD_EMOJI[d.mood]:""}</span>)}
              </div>
              <ResponsiveContainer width="100%" height={72}>
                <LineChart data={chartData} margin={{top:0,right:5,left:-20,bottom:0}}>
                  <XAxis dataKey="d" tick={{fontSize:10,fontFamily:"'Nunito',sans-serif",fill:C.textLight}} axisLine={false} tickLine={false}/>
                  <Tooltip formatter={v=>v?[`${v}/5`,"Mood"]:["No data",""]} contentStyle={{fontFamily:"'Nunito',sans-serif",fontSize:12,borderRadius:8}}/>
                  <Line type="monotone" dataKey="s" stroke={C.blue} strokeWidth={2.5} dot={{fill:C.blue,r:4,strokeWidth:0}} connectNulls/>
                </LineChart>
              </ResponsiveContainer>
            </>
          ):(
            <p style={{fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textLight,textAlign:"center",padding:"20px 0",margin:0}}>No mood data yet — select your mood on the Home screen each day to see your trend.</p>
          )}
        </div>
        {moodHistory.length>0&&(
          <>
            <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text,margin:"0 0 8px"}}>Mood Log</p>
            <div style={{background:"white",borderRadius:16,boxShadow:"0 2px 10px rgba(60,100,150,0.09)",marginBottom:14,overflow:"hidden"}}>
              {moodHistory.slice().reverse().slice(0,10).map((entry,i,arr)=>(
                <div key={entry.date} style={{display:"flex",alignItems:"center",padding:"10px 14px",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none"}}>
                  <span style={{fontSize:20,marginRight:10}}>{MOOD_EMOJI[entry.mood]}</span>
                  <div style={{flex:1}}>
                    <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text,textTransform:"capitalize"}}>{entry.mood}</p>
                    <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{new Date(entry.date).toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"})}</p>
                  </div>
                  <div style={{display:"flex",gap:3}}>
                    {Array.from({length:5},(_,j)=><div key={j} style={{width:6,height:6,borderRadius:"50%",background:j<entry.score?C.blue:C.border}}/>)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
          {[{icon:"⏱️",bg:"#d4e8f8",t:"Breathing Reset",s:"2-min guided exercise"},{icon:"📝",bg:"#f0e8d8",t:"Journal",s:"Write about your week"}].map((s,i)=>(
            <div key={i} style={{background:"white",borderRadius:16,padding:"12px",boxShadow:"0 2px 8px rgba(60,100,150,0.09)"}}>
              <div style={{width:36,height:36,borderRadius:10,background:s.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,marginBottom:7}}>{s.icon}</div>
              <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:12,color:C.text}}>{s.t}</p>
              <p style={{margin:"0 0 9px",fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{s.s}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── PROFILE ──────────────────────────────────────────────
function ProfileScreen({ moodHistory, onNav }) {
  const streak=(()=>{
    if(!moodHistory.length) return 0;
    let count=0; const exp=new Date();
    const sorted=moodHistory.slice().sort((a,b)=>b.date.localeCompare(a.date));
    for(const entry of sorted){
      if(entry.date===exp.toISOString().slice(0,10)){count++;exp.setDate(exp.getDate()-1);}else break;
    }
    return count;
  })();

  return(
    <div style={{flex:1,overflowY:"auto",background:C.bg}}>
      <div style={{background:"white",padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${C.border}`}}>
        <h2 style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:20,color:C.text}}>Profile</h2>
        <div style={{width:34,height:34,borderRadius:"50%",border:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>✏️</div>
      </div>
      <div style={{padding:"14px"}}>
        <div style={{background:"linear-gradient(135deg,white 60%,#d8eaf8)",borderRadius:18,padding:"18px",boxShadow:"0 4px 20px rgba(60,100,150,0.12)",marginBottom:18,display:"flex",alignItems:"center",gap:14,position:"relative",overflow:"hidden"}}>
          <div style={{width:60,height:60,borderRadius:"50%",background:C.blueLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,border:"3px solid white",boxShadow:"0 2px 10px rgba(60,100,150,0.15)",flexShrink:0}}>👩</div>
          <div style={{flex:1}}>
            <p style={{margin:"0 0 4px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:18,color:C.text}}>Alex</p>
            <p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid}}>🔥 Mood Streak: <strong>{streak}</strong> {streak===1?"day":"days"}</p>
            <p style={{margin:"0 0 10px",fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textMid}}>📅 Days tracked: <strong>{moodHistory.length}</strong></p>
            <button style={{padding:"6px 14px",borderRadius:18,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>✏️ Edit Profile</button>
          </div>
          <div style={{position:"absolute",right:-8,bottom:-12,opacity:0.4}}><Ellie size={80} pose="glasses"/></div>
        </div>

        {moodHistory.length>0&&(
          <div style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:13,color:C.text,margin:0}}>Recent Mood Log</p>
              <button onClick={()=>onNav("insights")} style={{fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.blue,fontWeight:700,background:"none",border:"none",cursor:"pointer"}}>See all ›</button>
            </div>
            <div style={{background:"white",borderRadius:16,boxShadow:"0 2px 10px rgba(60,100,150,0.08)",overflow:"hidden"}}>
              {moodHistory.slice().reverse().slice(0,5).map((entry,i,arr)=>(
                <div key={entry.date} style={{display:"flex",alignItems:"center",padding:"9px 14px",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none"}}>
                  <span style={{fontSize:18,marginRight:10}}>{MOOD_EMOJI[entry.mood]}</span>
                  <p style={{flex:1,margin:0,fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.text,textTransform:"capitalize",fontWeight:600}}>{entry.mood}</p>
                  <p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{new Date(entry.date).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {[{section:"My Information",items:[{icon:"👤",t:"Personal Details",s:"Manage your personal info",action:null},{icon:"😊",t:"Mood Log",s:`${moodHistory.length} entries tracked`,action:()=>onNav("insights")},{icon:"📝",t:"Journal",s:"Your written entries",action:()=>onNav("journal")}]},{section:"Support",items:[{icon:"👩‍⚕️",t:"Find a Therapist",s:"Browse & book licensed professionals",action:()=>onNav("therapist"),highlight:true},{icon:"🤝",t:"I Need Support Now",s:"Crisis resources & immediate help",action:()=>onNav("distress"),urgent:true}]},{section:"App Settings",items:[{icon:"🔔",t:"Reminder Notifications",s:"Manage your reminders",action:null},{icon:"🛡️",t:"Privacy and Security",s:"",action:null},{icon:"⚙️",t:"Help & Support",s:"",action:null}]}].map((grp,gi)=>(
          <div key={gi} style={{marginBottom:14}}>
            <p style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:13,color:C.text,margin:"0 0 8px"}}>{grp.section}</p>
            <div style={{background:"white",borderRadius:16,boxShadow:"0 2px 10px rgba(60,100,150,0.08)",overflow:"hidden"}}>
              {grp.items.map((item,i)=>(
                <div key={i} onClick={item.action||undefined} style={{display:"flex",alignItems:"center",padding:"12px 14px",borderBottom:i<grp.items.length-1?`1px solid ${C.border}`:"none",cursor:item.action?"pointer":"default",background:item.urgent?"#fff8f8":item.highlight?"#f5faff":"white"}}>
                  <div style={{width:36,height:36,borderRadius:10,background:item.urgent?"#fde0e0":item.highlight?C.blueLight:C.blueXLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,marginRight:10}}>{item.icon}</div>
                  <div style={{flex:1}}><p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:item.urgent?"#b84040":C.text}}>{item.t}</p>{item.s&&<p style={{margin:0,fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textLight}}>{item.s}</p>}</div>
                  {item.action&&<span style={{color:item.urgent?"#d05a5a":C.textLight}}>›</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div style={{display:"flex",justifyContent:"center",padding:"10px 0 20px"}}><Ellie size={70} pose="normal"/></div>
      </div>
    </div>
  );
}

// ── THERAPIST & DISTRESS (compact) ──────────────────────────────────────────────
const THERAPISTS=[{name:"Dr. Emma Stevens, PhD",title:"Clinical Psychologist",tags:["Anxiety","Stress","CBT"],rating:4.9,reviews:125,next:"Today 4:30 PM",avatar:"👩‍⚕️",price:50},{name:"Claire Miller, LPC",title:"Licensed Therapist",tags:["Depression","Self-Esteem"],rating:4.8,reviews:150,next:"Tomorrow 10:00 AM",avatar:"👩‍⚕️",price:40},{name:"David Kim, LCSW",title:"Licensed Clinical Social Worker",tags:["Trauma","Grief"],rating:4.8,reviews:100,next:"Today 6:00 PM",avatar:"👨‍⚕️",price:45}];
function TherapistScreen({onNav}){
  const [view,setView]=useState("list");const [sel,setSel]=useState(null);const [slot,setSlot]=useState("10:00 AM");const [done,setDone]=useState(false);
  if(done) return(<div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:C.bg,padding:32,textAlign:"center"}}><span style={{fontSize:64,marginBottom:16}}>✅</span><Ellie size={72}/><h2 style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:20,color:C.text,margin:"14px 0 8px"}}>Session Confirmed!</h2><p style={{fontFamily:"'Nunito',sans-serif",color:C.textMid,fontSize:13,margin:"0 0 24px"}}>Your session with {sel?.name.split(",")[0]} at {slot} is booked.</p><button onClick={()=>{setDone(false);setView("list");onNav("home");}} style={{padding:"12px 28px",borderRadius:14,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>Back to Home</button></div>);
  if(view==="booking"&&sel) return(<div style={{flex:1,overflowY:"auto",background:C.bg}}><div style={{background:"white",padding:"12px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.border}`}}><button onClick={()=>setView("profile")} style={{background:"none",border:"none",color:C.blue,fontSize:20,cursor:"pointer"}}>←</button><h2 style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:17,color:C.text}}>Confirm Booking</h2></div><div style={{padding:16}}>{[["Date","Thursday, April 25"],["Time",slot],["Session","45-min Video Session"],["Total",`$${sel.price}/session`]].map(([l,v])=><div key={l} style={{background:"white",borderRadius:12,padding:"12px 14px",boxShadow:"0 2px 6px rgba(60,100,150,0.07)",marginBottom:8,display:"flex",justifyContent:"space-between"}}><span style={{fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.textMid}}>{l}</span><span style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text}}>{v}</span></div>)}<button onClick={()=>setDone(true)} style={{width:"100%",padding:"14px",borderRadius:16,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:15,cursor:"pointer"}}>Confirm & Pay ${sel.price}</button></div></div>);
  if(view==="profile"&&sel) return(<div style={{flex:1,overflowY:"auto",background:C.bg}}><div style={{background:"white",padding:"12px 16px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${C.border}`}}><button onClick={()=>setView("list")} style={{background:"none",border:"none",color:C.blue,fontSize:20,cursor:"pointer"}}>←</button><h2 style={{margin:0,fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:17,color:C.text}}>{sel.name}</h2></div><div style={{padding:16}}><div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>{["10:00 AM","1:00 PM","3:30 PM","5:00 PM"].map(s=><button key={s} onClick={()=>setSlot(s)} style={{padding:"9px 14px",borderRadius:11,border:"none",cursor:"pointer",background:slot===s?`linear-gradient(135deg,${C.blue},${C.blueDark})`:"white",color:slot===s?"white":C.text,fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,boxShadow:"0 2px 6px rgba(60,100,150,0.10)"}}>{s}</button>)}</div><button onClick={()=>setView("booking")} style={{width:"100%",padding:"13px",borderRadius:14,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:15,cursor:"pointer"}}>Book {slot} — ${sel.price}/session</button></div></div>);
  return(<div style={{flex:1,overflowY:"auto",background:C.bg}}><div style={{background:"white",padding:"12px 16px 10px",borderBottom:`1px solid ${C.border}`}}><h2 style={{margin:"0 0 10px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:18,color:C.text}}>Find a Therapist</h2><div style={{background:C.bg,borderRadius:22,padding:"9px 14px",display:"flex",gap:8,border:`1px solid ${C.border}`}}><span>🔍</span><input placeholder="Search..." style={{border:"none",background:"transparent",fontFamily:"'Nunito',sans-serif",fontSize:13,color:C.text,outline:"none",flex:1}}/></div></div><div style={{padding:"12px 14px",display:"flex",flexDirection:"column",gap:10}}>{THERAPISTS.map((t,i)=><div key={i} style={{background:"white",borderRadius:16,padding:"14px",boxShadow:"0 2px 10px rgba(60,100,150,0.09)"}}><div style={{display:"flex",gap:10,marginBottom:10}}><div style={{width:50,height:50,borderRadius:14,background:C.blueLight,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>{t.avatar}</div><div style={{flex:1}}><p style={{margin:"0 0 2px",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:14,color:C.text}}>{t.name}</p><p style={{margin:"0 0 4px",fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textMid}}>{t.title}</p><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{t.tags.map(tag=><span key={tag} style={{padding:"2px 7px",borderRadius:10,background:C.blueXLight,color:C.blue,fontSize:10,fontFamily:"'Nunito',sans-serif"}}>{tag}</span>)}</div></div></div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><span style={{color:C.yellow,fontSize:12}}>⭐ {t.rating}</span><p style={{margin:"2px 0 0",fontFamily:"'Nunito',sans-serif",fontSize:11,color:C.textMid}}>{t.next}</p></div><button onClick={()=>{setSel(t);setView("profile");}} style={{padding:"8px 14px",borderRadius:10,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:12,cursor:"pointer"}}>View Profile ›</button></div></div>)}</div></div>);
}
function DistressScreen({onNav}){
  return(<div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"linear-gradient(180deg,#d8eaf8,#eef5fc)",padding:32,textAlign:"center"}}><Ellie size={110} pose="doctor"/><h2 style={{fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:24,color:C.text,margin:"20px 0 10px",lineHeight:1.3}}>You don't have to<br/>handle this alone.</h2><p style={{fontFamily:"'Nunito',sans-serif",fontSize:14,color:C.textMid,margin:"0 0 28px",lineHeight:1.6}}>Talking with a trained therapist could help you feel supported right now.</p><button onClick={()=>onNav("therapist")} style={{width:"100%",maxWidth:300,padding:"15px",borderRadius:18,border:"none",background:`linear-gradient(135deg,${C.blue},${C.blueDark})`,color:"white",fontFamily:"'Nunito',sans-serif",fontWeight:800,fontSize:15,cursor:"pointer",marginBottom:6}}>Connect with a Therapist</button><p style={{fontFamily:"'Nunito',sans-serif",fontSize:12,color:C.textLight,margin:"8px 0"}}>or</p><button onClick={()=>onNav("chat")} style={{width:"100%",maxWidth:300,padding:"13px",borderRadius:18,border:`1px solid ${C.border}`,background:"white",color:C.textMid,fontFamily:"'Nunito',sans-serif",fontWeight:600,fontSize:14,cursor:"pointer"}}>Continue chatting with AniMind ›</button></div>);
}

// ── APP ──────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("home");
  const [currentMood, setCurrentMood] = useState("stressed");
  const [moodHistory, setMoodHistory] = useState([]);
  const mainTabs = ["home","chat","exercises","insights","profile"];

  useEffect(()=>{ loadMoodHistory().then(setMoodHistory); },[]);

  async function handleSetMood(mood) {
    setCurrentMood(mood);
    await saveMoodEntry(mood);
    loadMoodHistory().then(setMoodHistory);
  }

  const screens = {
    home: <HomeScreen onNav={setScreen} mood={currentMood} setMood={handleSetMood} moodHistory={moodHistory}/>,
    chat: <ChatScreen onNav={setScreen} currentMood={currentMood}/>,
    exercises: <ExercisesScreen onNav={setScreen}/>,
    insights: <InsightsScreen currentMood={currentMood} moodHistory={moodHistory}/>,
    profile: <ProfileScreen moodHistory={moodHistory} onNav={setScreen}/>,
    journal: <JournalScreen onNav={setScreen} currentMood={currentMood}/>,
    therapist: <TherapistScreen onNav={setScreen}/>,
    distress: <DistressScreen onNav={setScreen}/>,
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #c0d8e8; border-radius: 2px; }
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-5px)} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
      <div style={{width:"100%",height:"100vh",background:"linear-gradient(135deg,#b8d4ec,#d0e4f4)",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{width:390,height:844,maxHeight:"100vh",background:C.bg,borderRadius:40,boxShadow:"0 30px 80px rgba(40,80,140,0.3), 0 0 0 8px #a8c4dc, 0 0 0 10px #90b4cc",display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
          <div style={{background:"white",padding:"10px 22px 6px",display:"flex",justifyContent:"space-between",flexShrink:0}}>
            <span style={{fontFamily:"'Nunito',sans-serif",fontWeight:700,fontSize:13,color:C.text}}>9:41</span>
            <div style={{display:"flex",gap:4,fontSize:13}}>📶🔋</div>
          </div>
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {screens[screen]}
          </div>
          {mainTabs.includes(screen)&&<Nav active={screen} onNav={setScreen}/>}
        </div>
      </div>
    </>
  );
}
