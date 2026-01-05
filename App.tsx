
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { CallStatus, TranscriptionEntry, PatientRecord, AppView } from './types.ts';
import { decode, decodeAudioData, createBlob } from './audioUtils.ts';
import { 
  SYSTEM_PROMPT, SEARCH_TOOL, WEB_SEARCH_TOOL, SAVE_PATIENT_TOOL,
  ICON_MIC, ICON_PHONE_OFF, ICON_HEART, ICON_MAP_PIN, ICON_GLOBE,
  ICON_LAYOUT, ICON_USERS, ICON_SETTINGS 
} from './constants.tsx';

interface ResourceResult {
  title: string;
  uri: string;
}

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('assistant');
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapResults, setMapResults] = useState<ResourceResult[]>([]);
  const [webResults, setWebResults] = useState<ResourceResult[]>([]);
  
  // Admin authentication
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(false);
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [patients, setPatients] = useState<PatientRecord[]>([]);

  const isKeyAvailable = !!process.env.API_KEY;

  useEffect(() => {
    const saved = localStorage.getItem('nira_leads');
    if (saved) {
      try { setPatients(JSON.parse(saved)); } catch (e) { console.error("Data load failed", e); }
    }
    const auth = localStorage.getItem('nira_admin_auth');
    if (auth === 'true') setIsAdminAuthenticated(true);
  }, []);

  useEffect(() => {
    localStorage.setItem('nira_leads', JSON.stringify(patients));
  }, [patients]);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const lastTranscriptionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (view === 'assistant') {
      lastTranscriptionRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptions, view]);

  const handleKeySelection = async () => {
    const aistudio = (window as any).aistudio;
    if (aistudio && typeof aistudio.openSelectKey === 'function') {
      await aistudio.openSelectKey();
    } else {
      alert("Please set API_KEY in your environment or Vercel dashboard.");
    }
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (adminPassword === 'admin123') { 
      setIsAdminAuthenticated(true);
      localStorage.setItem('nira_admin_auth', 'true');
      setLoginError('');
    } else {
      setLoginError('ভুল পাসওয়ার্ড, আবার চেষ্টা করুন।');
    }
  };

  const handleAdminLogout = () => {
    setIsAdminAuthenticated(false);
    localStorage.removeItem('nira_admin_auth');
    setView('assistant');
  };

  const saveLead = (name: string, phone: string, email: string) => {
    const newRecord: PatientRecord = {
      id: Math.random().toString(36).substr(2, 9),
      name,
      phone,
      email,
      timestamp: Date.now(),
      status: 'new'
    };
    setPatients(prev => [newRecord, ...prev]);
    return "তথ্য সংরক্ষিত হয়েছে।";
  };

  const deleteLead = (id: string) => setPatients(prev => prev.filter(p => p.id !== id));

  const handleStopCall = useCallback(() => {
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (scriptProcessorRef.current) { scriptProcessorRef.current.disconnect(); scriptProcessorRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
    audioSourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setStatus(CallStatus.IDLE);
  }, []);

  const handleStartCall = async () => {
    try {
      const aistudio = (window as any).aistudio;
      if (aistudio) {
        const hasKey = await aistudio.hasSelectedApiKey();
        if (!hasKey) await handleKeySelection();
      }

      if (!process.env.API_KEY) {
        setStatus(CallStatus.ERROR);
        setError("An API Key must be set when running in a browser");
        return;
      }

      setStatus(CallStatus.CONNECTING);
      setError(null);

      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inCtx;
      outputAudioContextRef.current = outCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setStatus(CallStatus.ACTIVE);
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => { session.sendRealtimeInput({ media: pcmBlob }); });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                let toolResponse: any = "ok";
                if (fc.name === 'savePatientData') {
                  const args = fc.args as any;
                  toolResponse = saveLead(args.name, args.phone, args.email);
                }
                sessionPromise.then(session => {
                  session.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result: toolResponse } }
                  });
                });
              }
            }

            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            if (message.serverContent?.outputTranscription) currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            if (message.serverContent?.inputTranscription) currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            
            if (message.serverContent?.turnComplete) {
              setTranscriptions(prev => [...prev, { role: 'user', text: currentInputTranscriptionRef.current, timestamp: Date.now() }, { role: 'nira', text: currentOutputTranscriptionRef.current, timestamp: Date.now() }]);
              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const audioCtx = outputAudioContextRef.current;
              if (audioCtx) {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
                const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
                const source = audioCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioCtx.destination);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioSourcesRef.current.add(source);
                source.addEventListener('ended', () => { audioSourcesRef.current.delete(source); });
              }
            }
          },
          onerror: (e: any) => {
            console.error("Live Error:", e);
            if (e?.message?.includes("Requested entity was not found.")) handleKeySelection();
            setError("সংযোগ ত্রুটি: এপিআই কি চেক করুন।");
            handleStopCall();
          },
          onclose: () => handleStopCall(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: [SAVE_PATIENT_TOOL] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message || 'সংযোগ ত্রুটি');
      setStatus(CallStatus.ERROR);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f0f4f8] font-sans text-slate-900">
      {/* Header - Matching screenshot */}
      <header className="w-full bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#059669] rounded-full flex items-center justify-center shadow-md">
            <div className="scale-125">{ICON_HEART}</div>
          </div>
          <div className="flex flex-col">
            <h1 className="text-2xl font-black text-slate-800 tracking-tight">হেলথ সাপোর্ট</h1>
            <p className="text-xs text-slate-500 font-medium">ভার্চুয়াল সহকারী: নিরা</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="bg-[#dcfce7] text-[#166534] px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-2">
            <div className="w-2 h-2 bg-[#22c55e] rounded-full"></div>
            অনলাইন
          </div>
          <button onClick={() => setView(view === 'assistant' ? 'admin' : 'assistant')} className="p-2 text-slate-400 hover:text-emerald-600 transition-colors">
            {ICON_SETTINGS}
          </button>
        </div>
      </header>

      {view === 'assistant' ? (
        <main className="flex-1 max-w-[1440px] mx-auto w-full p-6 md:p-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          
          {/* Column 1: Call Panel */}
          <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 p-8 flex flex-col items-center justify-center text-center">
            <div className="w-48 h-48 bg-[#f1f5f9] rounded-full flex items-center justify-center mb-8">
              <div className="scale-[2.5] text-slate-400">
                {status === CallStatus.ACTIVE ? (
                  <div className="flex gap-1 items-end">
                    <div className="w-1 h-4 bg-emerald-500 animate-bounce"></div>
                    <div className="w-1 h-8 bg-emerald-500 animate-bounce [animation-delay:0.1s]"></div>
                    <div className="w-1 h-5 bg-emerald-500 animate-bounce [animation-delay:0.2s]"></div>
                  </div>
                ) : ICON_MIC}
              </div>
            </div>
            
            <h2 className={`text-2xl font-black mb-2 ${status === CallStatus.ERROR ? 'text-slate-800' : 'text-slate-800'}`}>
              {status === CallStatus.IDLE && "সহায়তার জন্য প্রস্তুত"}
              {status === CallStatus.CONNECTING && "সংযোগ হচ্ছে..."}
              {status === CallStatus.ACTIVE && "নিরা শুনছে..."}
              {status === CallStatus.ERROR && "সংযোগ ত্রুটি"}
            </h2>
            
            <p className="text-slate-500 text-sm leading-relaxed mb-10 px-4">
              {status === CallStatus.ERROR ? error : "নিরার সাথে নিরাপদ ভয়েস কনসালটেশন শুরু করতে নিচের বোতামটি ক্লিক করুন।"}
            </p>

            <button
              onClick={status === CallStatus.ACTIVE ? handleStopCall : handleStartCall}
              className={`w-full max-w-[240px] flex items-center justify-center gap-3 py-4 rounded-3xl font-black text-white transition-all shadow-lg active:scale-95 ${status === CallStatus.ACTIVE ? 'bg-red-500 shadow-red-100' : 'bg-[#059669] shadow-emerald-100'}`}
            >
              <div className="scale-75">{status === CallStatus.ACTIVE ? ICON_PHONE_OFF : ICON_MIC}</div>
              <span>{status === CallStatus.ACTIVE ? 'কল শেষ করুন' : 'কল শুরু করুন'}</span>
            </button>
          </div>

          {/* Column 2: Transcript Panel */}
          <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 flex flex-col overflow-hidden">
            <div className="p-6 border-b border-slate-50 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              <h3 className="font-black text-slate-800 text-sm tracking-wide">লাইভ ট্রান্সক্রিপ্ট</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {transcriptions.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-60">
                   <div className="scale-[2] mb-6">
                     <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                   </div>
                   <p className="text-xs font-medium italic text-center px-4">কথোপকথন এখানে রেকর্ড করা হবে</p>
                </div>
              ) : transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl p-4 text-sm font-medium ${t.role === 'user' ? 'bg-[#059669] text-white rounded-tr-none' : 'bg-slate-100 text-slate-700 rounded-tl-none'}`}>
                    {t.text}
                  </div>
                </div>
              ))}
              <div ref={lastTranscriptionRef} />
            </div>
          </div>

          {/* Column 3: Map Panel */}
          <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 flex flex-col overflow-hidden">
            <div className="p-6 border-b border-slate-50 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              <h3 className="font-black text-slate-800 text-sm tracking-wide">ম্যাপ লোকেশন</h3>
            </div>
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-slate-300 opacity-60">
               <div className="scale-[2.5] mb-8">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
               </div>
               <p className="text-xs font-medium italic text-center px-4 leading-relaxed">কাছাকাছি হাসপাতাল বা ডাক্তারের<br/>তথ্য এখানে আসবে।</p>
            </div>
          </div>

          {/* Column 4: Web Panel */}
          <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 flex flex-col overflow-hidden">
            <div className="p-6 border-b border-slate-50 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500"></div>
              <h3 className="font-black text-slate-800 text-sm tracking-wide">ওয়েবসাইট ও বিস্তারিত</h3>
            </div>
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-slate-300 opacity-60">
               <div className="scale-[2.5] mb-8">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
               </div>
               <p className="text-xs font-medium italic text-center px-4 leading-relaxed">টেস্টের খরচ বা প্রস্তুতির নিয়ম<br/>এখানে দেখা যাবে।</p>
            </div>
          </div>

        </main>
      ) : (
        /* Admin View */
        <main className="flex-1 max-w-5xl mx-auto w-full p-6 md:p-10 animate-in fade-in duration-500">
          {!isAdminAuthenticated ? (
            <div className="max-w-md mx-auto mt-20 bg-white p-10 rounded-3xl shadow-xl border border-slate-100">
              <h2 className="text-2xl font-black text-center mb-8">অ্যাডমিন লগইন</h2>
              <form onSubmit={handleAdminLogin} className="space-y-6">
                <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="পাসওয়ার্ড (admin123)" className="w-full px-5 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm" required />
                {loginError && <p className="text-red-500 text-xs font-bold">{loginError}</p>}
                <button className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black uppercase">লগইন করুন</button>
              </form>
            </div>
          ) : (
            <div className="space-y-8">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black">অ্যাডমিন ড্যাশবোর্ড</h2>
                <button onClick={handleAdminLogout} className="px-4 py-2 bg-red-50 text-red-600 rounded-xl text-xs font-black uppercase">লগআউট</button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-md">
                   <h4 className="text-sm font-black uppercase tracking-widest mb-6">এপিআই কনফিগারেশন</h4>
                   <div className={`p-4 rounded-2xl border mb-4 ${isKeyAvailable ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                      <p className="text-xs font-black uppercase">এপিআই স্ট্যাটাস</p>
                      <p className="text-sm font-bold">{isKeyAvailable ? 'সংযুক্ত (Environment/Vercel)' : 'পাওয়া যায়নি'}</p>
                   </div>
                   <button onClick={handleKeySelection} className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-emerald-100">ব্রাউজারে কি সেট করুন</button>
                </div>
                <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-md">
                   <h4 className="text-sm font-black uppercase tracking-widest mb-4">রোগীর তালিকা</h4>
                   <div className="overflow-x-auto">
                     <table className="w-full text-left">
                       <tbody className="divide-y divide-slate-50">
                         {patients.length === 0 ? <tr><td className="py-4 text-center text-slate-400 italic">ডেটা নেই</td></tr> : patients.map(p => (
                           <tr key={p.id}>
                             <td className="py-4 text-xs font-bold">{p.name}<br/><span className="text-slate-400 font-normal">{p.phone}</span></td>
                             <td className="py-4 text-right"><button onClick={() => deleteLead(p.id)} className="text-red-500 text-[10px] font-black uppercase">মুছে ফেলুন</button></td>
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   </div>
                </div>
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
};

export default App;
