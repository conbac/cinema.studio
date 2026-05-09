import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { 
  Loader2, Play, Pause, Film, AlertCircle, Image as ImageIcon, Download, Clock, ChevronRight
} from 'lucide-react';

// Cấu hình Firebase
let app, auth, db, firebaseConfig;
try {
  const configRaw = typeof __firebase_config !== 'undefined' ? __firebase_config : null;
  if (configRaw) {
    firebaseConfig = JSON.parse(configRaw);
    if (getApps().length === 0) {
      app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      db = getFirestore(app);
    }
  }
} catch (e) {
  console.error("Firebase Init Fail:", e);
}

const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const apiKey = ""; 

// Hàm lọc JSON sạch để tránh lỗi "Unexpected character"
const extractJSON = (str) => {
  try {
    const firstBracket = str.indexOf('{');
    const lastBracket = str.lastIndexOf('}');
    if (firstBracket !== -1 && lastBracket !== -1) {
      return str.substring(firstBracket, lastBracket + 1);
    }
    return str;
  } catch (e) { return str; }
};

function pcmToWav(pcmBase64, sampleRate = 24000) {
  try {
    const binaryString = window.atob(pcmBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    const buffer = new ArrayBuffer(44 + bytes.length);
    const view = new DataView(buffer);
    const writeString = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + bytes.length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, bytes.length, true);
    new Uint8Array(buffer, 44).set(bytes);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  } catch (e) { return null; }
}

const apiCall = async (model, payload, retries = 5) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let delay = 1000;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`Lỗi API: ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2; // Exponential backoff
    }
  }
};

export default function App() {
  const [user, setUser] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [sceneCount, setSceneCount] = useState(4);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef(null);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        await signInAnonymously(auth);
      }
    };
    initAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  const generateFilm = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setStatus('Đang biên kịch...');
    setErrorMsg('');
    setResult(null);
    setCurrentIdx(0);
    setIsPlaying(false);

    try {
      const scriptRes = await apiCall('gemini-2.5-flash-preview-09-2025', {
        contents: [{ parts: [{ text: `Create a cinematic noir script with exactly ${sceneCount} scenes about: "${prompt}". Return ONLY JSON.` }] }],
        systemInstruction: { parts: [{ text: `Return JSON: { "title": "string", "panels": [{ "text": "Vietnamese subtitle", "image_prompt": "detailed english cinematic prompt" }] }` }] },
        generationConfig: { responseMimeType: "application/json" }
      });

      const rawJson = scriptRes.candidates[0].content.parts[0].text;
      const script = JSON.parse(extractJSON(rawJson));
      setResult({ ...script, panels: script.panels.map(p => ({ ...p, status: 'loading' })) });

      for (let i = 0; i < script.panels.length; i++) {
        setStatus(`Đang dựng cảnh ${i + 1}/${script.panels.length}...`);
        
        const [imgRes, audRes] = await Promise.allSettled([
          apiCall('gemini-2.5-flash-image-preview', {
            contents: [{ parts: [{ text: script.panels[i].image_prompt + " cinematic noir style, highly detailed" }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
          }),
          apiCall('gemini-2.5-flash-preview-tts', {
            contents: [{ parts: [{ text: script.panels[i].text }] }],
            generationConfig: { 
              responseModalities: ["AUDIO"], 
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } } 
            },
            model: "gemini-2.5-flash-preview-tts"
          })
        ]);

        let imgData = null;
        if (imgRes.status === 'fulfilled') {
          const imgPart = imgRes.value.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
          if (imgPart) imgData = `data:image/png;base64,${imgPart.inlineData.data}`;
        }

        let audUrl = null;
        if (audRes.status === 'fulfilled') {
          const audPart = audRes.value.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
          if (audPart) audUrl = pcmToWav(audPart.inlineData.data);
        }

        setResult(prev => ({
          ...prev,
          panels: prev.panels.map((p, idx) => idx === i ? { ...p, image: imgData, audio: audUrl, status: imgData ? 'ready' : 'error' } : p)
        }));
      }
      setStatus('');
    } catch (e) {
      setErrorMsg(`Lỗi xử lý: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const playNext = useCallback(() => {
    if (!isPlayingRef.current) return;
    setCurrentIdx(prev => {
      if (prev < (result?.panels.length || 0) - 1) return prev + 1;
      setIsPlaying(false);
      isPlayingRef.current = false;
      return prev;
    });
  }, [result]);

  useEffect(() => {
    if (isPlaying && result?.panels[currentIdx]?.audio && audioRef.current) {
      audioRef.current.src = result.panels[currentIdx].audio;
      audioRef.current.play().catch(() => {});
    }
  }, [currentIdx, isPlaying, result]);

  const exportVideo = async () => {
    if (!result || exporting) return;
    setExporting(true);
    setStatus('Đang chuẩn bị phòng xuất phim...');
    
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
      const chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${result.title || 'noir-film'}.webm`;
        a.click();
        setExporting(false);
        setStatus('');
      };

      recorder.start();

      for (let i = 0; i < result.panels.length; i++) {
        setCurrentIdx(i);
        setStatus(`Đang ghi hình cảnh ${i + 1}...`);
        
        const panel = result.panels[i];
        if (!panel.image) continue;

        const img = new Image();
        img.src = panel.image;
        await new Promise(r => img.onload = r);

        // Mỗi cảnh kéo dài 4 giây
        const duration = 4000;
        const start = Date.now();
        while (Date.now() - start < duration) {
          ctx.fillStyle = 'black';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          
          // Hiệu ứng zoom nhẹ (Ken Burns)
          const progress = (Date.now() - start) / duration;
          const scale = 1 + (progress * 0.05);
          const w = canvas.width * scale;
          const h = canvas.height * scale;
          const x = (canvas.width - w) / 2;
          const y = (canvas.height - h) / 2;
          
          ctx.drawImage(img, x, y, w, h);
          
          // Phụ đề
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(0, canvas.height - 120, canvas.width, 120);
          
          ctx.fillStyle = 'white';
          ctx.font = 'italic 32px Georgia';
          ctx.textAlign = 'center';
          ctx.shadowBlur = 4;
          ctx.shadowColor = 'black';
          ctx.fillText(panel.text, canvas.width/2, canvas.height - 50);
          
          await new Promise(r => requestAnimationFrame(r));
        }
      }

      recorder.stop();
    } catch (e) {
      setErrorMsg("Lỗi xuất phim: " + e.message);
      setExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-400 font-sans flex flex-col p-4 md:p-8">
      <div className="max-w-5xl mx-auto w-full flex-1 flex flex-col space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div className="space-y-1">
            <h1 className="text-white text-2xl font-black tracking-tighter italic">NOIR STUDIO PRO</h1>
            <div className="flex items-center gap-2 text-[10px] text-zinc-600 uppercase tracking-[0.3em]">
              <div className="w-2 h-2 rounded-full bg-red-600 animate-pulse" />
              RECORDING SESSION
            </div>
          </div>
          
          <div className="flex flex-col md:flex-row bg-zinc-900/50 p-2 rounded-xl border border-white/5 gap-2 w-full md:w-auto">
            <div className="flex items-center px-3 gap-2 border-r border-white/5">
              <Clock size={14} />
              <select 
                value={sceneCount}
                onChange={e => setSceneCount(Number(e.target.value))}
                className="bg-transparent text-xs text-white outline-none cursor-pointer"
              >
                <option value={3}>3 Cảnh (Ngắn)</option>
                <option value={5}>5 Cảnh (Vừa)</option>
                <option value={8}>8 Cảnh (Dài)</option>
                <option value={10}>10 Cảnh (Phim ngắn)</option>
              </select>
            </div>
            <div className="flex flex-1">
              <input 
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="Ví dụ: Thám tử trong mưa..."
                className="bg-transparent px-4 py-2 text-sm outline-none flex-1 md:w-64 text-zinc-200"
              />
              <button 
                onClick={generateFilm}
                disabled={loading || exporting}
                className="bg-white text-black px-6 py-2 rounded-lg text-xs font-bold hover:bg-zinc-200 disabled:opacity-20 transition-all flex items-center gap-2"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} fill="black" />}
                TẠO PHIM
              </button>
            </div>
          </div>
        </header>

        {/* Status Bar */}
        {(status || errorMsg) && (
          <div className={`p-4 rounded-xl border text-xs uppercase tracking-widest flex items-center gap-4 transition-all ${errorMsg ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-white/5 border-white/10 text-zinc-300'}`}>
            {loading || exporting ? <Loader2 size={16} className="animate-spin" /> : <AlertCircle size={16} />}
            <span className="flex-1">{errorMsg || status}</span>
          </div>
        )}

        {/* Studio Workspace */}
        <main className="flex-1 flex flex-col lg:flex-row gap-8">
          <div className="flex-[3] flex flex-col gap-6">
            {result ? (
              <>
                <div className="relative aspect-video bg-zinc-950 rounded-2xl overflow-hidden border border-white/10 shadow-[0_0_50px_rgba(0,0,0,1)]">
                  {result.panels[currentIdx].image ? (
                    <img 
                      src={result.panels[currentIdx].image} 
                      className="w-full h-full object-cover transition-opacity duration-1000" 
                      key={currentIdx}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
                      <Loader2 size={40} className="text-zinc-700 animate-spin" />
                    </div>
                  )}
                  
                  <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-80" />
                  
                  <div className="absolute bottom-12 inset-x-8 text-center space-y-2">
                    <p className="text-white text-xl md:text-2xl font-serif italic leading-relaxed drop-shadow-2xl">
                      "{result.panels[currentIdx].text}"
                    </p>
                  </div>

                  {/* Scene Indicator */}
                  <div className="absolute top-6 left-6 bg-black/50 backdrop-blur px-3 py-1 rounded-full border border-white/10 text-[10px] text-white font-mono">
                    SCENE {currentIdx + 1} / {result.panels.length}
                  </div>
                </div>

                <div className="flex items-center justify-between bg-zinc-900/30 p-4 rounded-2xl border border-white/5">
                  <div className="flex gap-2">
                    {result.panels.map((p, i) => (
                      <button 
                        key={i}
                        onClick={() => { setCurrentIdx(i); setIsPlaying(false); }}
                        className={`h-1.5 rounded-full transition-all duration-500 ${currentIdx === i ? 'w-12 bg-white' : 'w-3 bg-zinc-800'}`}
                      />
                    ))}
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={exportVideo}
                      disabled={exporting || loading}
                      className="flex items-center gap-2 bg-zinc-800 border border-white/10 px-6 py-3 rounded-full text-xs font-bold text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                    >
                      {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                      XUẤT VIDEO (.WEBM)
                    </button>
                    
                    <button 
                      onClick={() => { setIsPlaying(!isPlaying); isPlayingRef.current = !isPlaying; }}
                      className="w-14 h-14 bg-white text-black rounded-full flex items-center justify-center hover:scale-110 active:scale-95 transition-all shadow-xl"
                    >
                      {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 border-2 border-dashed border-zinc-800 rounded-3xl flex flex-col items-center justify-center gap-6 opacity-30 group hover:opacity-50 transition-opacity">
                <div className="w-20 h-20 rounded-full border border-zinc-700 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Film size={32} strokeWidth={1} />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm tracking-[0.5em] uppercase font-bold">Studio Trống</p>
                  <p className="text-[10px]">Nhập ý tưởng và chọn thời lượng để bắt đầu</p>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: Script Details */}
          {result && (
            <div className="lg:w-80 space-y-6">
              <h3 className="text-white text-xs font-bold tracking-widest uppercase pb-4 border-b border-white/10">Kịch bản chi tiết</h3>
              <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                {result.panels.map((p, i) => (
                  <div 
                    key={i}
                    onClick={() => { setCurrentIdx(i); setIsPlaying(false); }}
                    className={`p-4 rounded-xl border transition-all cursor-pointer ${currentIdx === i ? 'bg-white/10 border-white/20' : 'bg-transparent border-transparent hover:bg-white/5'}`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] font-mono text-zinc-500">SCENE #{i+1}</span>
                      {p.status === 'ready' && <div className="w-1.5 h-1.5 rounded-full bg-green-500" />}
                    </div>
                    <p className="text-[11px] text-zinc-300 line-clamp-2 italic">"{p.text}"</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
      <audio ref={audioRef} onEnded={playNext} className="hidden" />
      
      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #27272a; border-radius: 10px; }
      `}} />
    </div>
  );
}
