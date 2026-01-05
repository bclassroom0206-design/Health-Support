
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { CallStatus, TranscriptionEntry, PatientRecord, AppView } from './types.ts';
import { decode, decodeAudioData, createBlob } from './audioUtils.ts';
import { 
  SYSTEM_PROMPT, SAVE_PATIENT_TOOL,
  ICON_MIC, ICON_PHONE_OFF, ICON_HEART, ICON_SETTINGS 
} from './constants.tsx';

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('assistant');
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [activeUserText, setActiveUserText] = useState('');
  const [activeNiraText, setActiveNiraText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastSavedPatient, setLastSavedPatient] = useState<string | null>(null);
  
  // Admin state
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
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const lastTranscriptionRef = useRef<HTMLDivElement | null>(null);

  // Accumulators for transcription
  const currentInputAcc = useRef('');
  const currentOutputAcc = useRef('');

  useEffect(() => {
    if (view === 'assistant') {
      lastTranscriptionRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptions, activeUserText, activeNiraText, view]);

  const handleKeySelection = async () => {
    const aistudio = (window as any).aistudio;
    if (aistudio && typeof aistudio.openSelectKey === 'function') {
      await aistudio.openSelectKey();
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
    setLastSavedPatient(name);
    setTimeout(() => setLastSavedPatient(null), 10000); // Clear notification after 10s
    return "সফলভাবে সংরক্ষিত। আপনি এখন রোগীকে জানাতে পারেন যে তাদের অ্যাপয়েন্টমেন্ট বুকিং সম্পন্ন হয়েছে।";
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
    setActiveUserText('');
    setActiveNiraText('');
    currentInputAcc.current = '';
    currentOutputAcc.current = '';
  }, []);

  const handleStartCall = async () => {
    try {
      const aistudio = (window as any).aistudio;
      if (aistudio) {
        const hasKey = await aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await handleKeySelection();
        }
      }

      if (!process.env.API_KEY) {
        if (aistudio) {
          await handleKeySelection();
        } else {
          setStatus(CallStatus.ERROR);
          setError("An API Key must be set when running in a browser");
          return;
        }
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

            if (message.serverContent?.inputTranscription) {
              const newText = message.serverContent.inputTranscription.text;
              currentInputAcc.current += newText;
              setActiveUserText(currentInputAcc.current);
            }
            if (message.serverContent?.outputTranscription) {
              const newText = message.serverContent.outputTranscription.text;
              currentOutputAcc.current += newText;
              setActiveNiraText(currentOutputAcc.current);
            }
            
            if (message.serverContent?.turnComplete) {
              setTranscriptions(prev => {
                const next = [...prev];
                if (currentInputAcc.current.trim()) {
                  next.push({ role: 'user', text: currentInputAcc.current, timestamp: Date.now() });
                }
                if (currentOutputAcc.current.trim()) {
                  next.push({ role: 'nira', text: currentOutputAcc.current, timestamp: Date.now() });
                }
                return next;
              });
              currentInputAcc.current = '';
              currentOutputAcc.current = '';
              setActiveUserText('');
              setActiveNiraText('');
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
            console.error("Live Error Detail:", e);
            const errMsg = e?.message || "";
            if (errMsg.includes("Requested entity was not found") || errMsg.includes("not found")) {
              handleKeySelection();
            }
            setError(`সংযোগ ত্রুটি: ${errMsg || "এপিআই কি চেক করুন।"}`);
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
      console.error("Connection catch block:", err);
      const errMsg = err.message || "";
      if (errMsg.includes("Requested entity was not found") || errMsg.includes("not found")) {
        handleKeySelection();
      }
      setError(errMsg || 'সংযোগ ত্রুটি');
      setStatus(CallStatus.ERROR);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f1f5f9] font-sans text-slate-900 overflow-x-hidden">
      {/* Header */}
      <header className="w-full bg-white border-b border-slate-200 px-4 md:px-8 py-3 md:py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-[#059669] rounded-xl md:rounded-2xl flex items-center justify-center shadow-md shadow-emerald-100">
            <div className="scale-100 md:scale-125 brightness-0 invert">{ICON_HEART}</div>
          </div>
          <div className="flex flex-col">
            <h1 className="text-lg md:text-2xl font-black text-[#1e293b] tracking-tight leading-none">হেলথ সাপোর্ট</h1>
            <p className="text-[10px] md:text-xs text-slate-500 font-bold uppercase tracking-wider opacity-80">ভার্চুয়াল সহকারী: নিরা</p>
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-4">
          <div className="bg-[#dcfce7] text-[#065f46] px-3 md:px-5 py-1 md:py-2 rounded-full text-[10px] md:text-xs font-black flex items-center gap-1.5 md:gap-2 shadow-sm border border-emerald-100">
            <div className="w-1.5 h-1.5 md:w-2 md:h-2 bg-[#10b981] rounded-full animate-pulse"></div>
            অনলাইন
          </div>
          <button onClick={() => setView(view === 'assistant' ? 'admin' : 'assistant')} className="p-2 text-slate-400 hover:text-[#059669] transition-all">
            {ICON_SETTINGS}
          </button>
        </div>
      </header>

      {view === 'assistant' ? (
        <main className="flex-1 max-w-[1536px] mx-auto w-full p-4 md:p-8 lg:p-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 items-stretch animate-in fade-in duration-700">
          
          {/* Column 1: Mic Panel */}
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] shadow-sm border border-slate-100 p-6 md:p-8 flex flex-col items-center justify-center text-center transition-all hover:shadow-xl hover:shadow-emerald-500/5 group relative">
            {lastSavedPatient && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 w-[90%] bg-emerald-600 text-white py-3 px-4 rounded-2xl text-xs font-bold animate-in slide-in-from-top-4 shadow-lg flex items-center gap-2">
                <div className="p-1 bg-white/20 rounded-full">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                বুকিং সম্পন্ন: {lastSavedPatient}
              </div>
            )}
            
            <div className={`w-36 h-36 md:w-48 md:h-48 rounded-full flex items-center justify-center mb-6 md:mb-10 transition-all duration-500 ${status === CallStatus.ACTIVE ? 'bg-emerald-50 scale-105' : 'bg-[#f1f5f9]'}`}>
              <div className={`scale-[1.8] md:scale-[2.5] transition-all duration-500 ${status === CallStatus.ACTIVE ? 'text-emerald-600' : 'text-slate-400 group-hover:scale-[2.8]'}`}>
                {status === CallStatus.ACTIVE ? (
                  <div className="flex gap-1 items-end">
                    <div className="w-1.5 h-6 bg-emerald-500 rounded-full animate-bounce"></div>
                    <div className="w-1.5 h-12 bg-emerald-500 rounded-full animate-bounce [animation-delay:0.1s]"></div>
                    <div className="w-1.5 h-8 bg-emerald-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                  </div>
                ) : ICON_MIC}
              </div>
            </div>
            
            <h2 className="text-xl md:text-2xl font-black mb-2 text-[#1e293b]">
              {status === CallStatus.IDLE && "সহায়তার জন্য প্রস্তুত"}
              {status === CallStatus.CONNECTING && "সংযোগ হচ্ছে..."}
              {status === CallStatus.ACTIVE && "নিরা শুনছে..."}
              {status === CallStatus.ERROR && "সংযোগ ত্রুটি"}
            </h2>
            
            <p className="text-slate-500 text-xs md:text-sm leading-relaxed mb-8 md:mb-10 px-4 font-medium opacity-80 min-h-[40px]">
              {status === CallStatus.ERROR ? error : "নিরার সাথে নিরাপদ ভয়েস কনসালটেশন শুরু করতে নিচের বোতামটি ক্লিক করুন।"}
            </p>

            <button
              onClick={status === CallStatus.ACTIVE ? handleStopCall : handleStartCall}
              className={`w-full max-w-[260px] flex items-center justify-center gap-3 py-4 md:py-4.5 rounded-[1.5rem] md:rounded-[2rem] font-black text-white transition-all shadow-xl active:scale-95 transform hover:-translate-y-1 ${status === CallStatus.ACTIVE ? 'bg-red-500 shadow-red-100 hover:bg-red-600' : 'bg-[#059669] shadow-emerald-200 hover:bg-[#047857]'}`}
            >
              <div className="scale-75 md:scale-90">{status === CallStatus.ACTIVE ? ICON_PHONE_OFF : ICON_MIC}</div>
              <span className="tracking-wide uppercase text-xs md:text-sm">{status === CallStatus.ACTIVE ? 'কল শেষ করুন' : 'কল শুরু করুন'}</span>
            </button>
          </div>

          {/* Column 2: Live Transcript */}
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col h-[400px] md:h-auto overflow-hidden transition-all hover:shadow-xl hover:shadow-emerald-500/5">
            <div className="p-5 md:p-7 border-b border-slate-50 flex items-center gap-2.5 md:gap-3">
              <div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full bg-[#10b981] animate-pulse"></div>
              <h3 className="font-black text-[#1e293b] text-xs md:text-sm uppercase tracking-widest">লাইভ ট্রান্সক্রিপ্ট</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-5 md:p-7 space-y-4 md:y-5 bg-[#fafcfd] custom-scrollbar">
              {transcriptions.length === 0 && !activeUserText && !activeNiraText ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 opacity-30">
                   <div className="scale-[2] md:scale-[2.5] mb-6 md:mb-8">
                     <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                   </div>
                   <p className="text-[10px] md:text-xs font-black uppercase tracking-widest text-center px-4 leading-relaxed">কথোপকথন এখানে রেকর্ড করা হবে</p>
                </div>
              ) : (
                <>
                  {transcriptions.map((t, i) => (
                    <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-1`}>
                      <div className={`max-w-[90%] md:max-w-[88%] rounded-xl md:rounded-2xl p-3 md:p-4 text-xs md:text-sm font-bold shadow-sm border ${t.role === 'user' ? 'bg-[#059669] text-white border-[#047857] rounded-tr-none' : 'bg-white text-slate-700 border-slate-100 rounded-tl-none'}`}>
                        {t.text}
                      </div>
                    </div>
                  ))}
                  {activeUserText && (
                    <div className="flex flex-col items-end">
                      <div className="max-w-[90%] md:max-w-[88%] rounded-xl md:rounded-2xl p-3 md:p-4 text-xs md:text-sm font-bold bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-tr-none italic">
                        {activeUserText}
                      </div>
                    </div>
                  )}
                  {activeNiraText && (
                    <div className="flex flex-col items-start animate-in fade-in">
                      <div className="max-w-[90%] md:max-w-[88%] rounded-xl md:rounded-2xl p-3 md:p-4 text-xs md:text-sm font-bold bg-white text-slate-600 border border-slate-100 rounded-tl-none shadow-sm">
                        {activeNiraText}
                        <span className="ml-1 inline-block w-1 h-3 bg-emerald-500 animate-pulse"></span>
                      </div>
                    </div>
                  )}
                </>
              )}
              <div ref={lastTranscriptionRef} />
            </div>
          </div>

          {/* Column 3: Map Location */}
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col h-[300px] md:h-auto overflow-hidden transition-all hover:shadow-xl hover:shadow-emerald-500/5">
            <div className="p-5 md:p-7 border-b border-slate-50 flex items-center gap-2.5 md:gap-3">
              <div className="w-2 md:w-2.5 h-2 md:h-2.5 rounded-full bg-[#10b981]"></div>
              <h3 className="font-black text-[#1e293b] text-xs md:text-sm uppercase tracking-widest">ম্যাপ লোকেশন</h3>
            </div>
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-slate-400 opacity-30">
               <div className="scale-[2] md:scale-[2.8] mb-6 md:mb-10">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
               </div>
               <p className="text-[10px] md:text-xs font-black uppercase tracking-widest text-center px-4 leading-relaxed">কাছাকাছি হাসপাতাল বা ডাক্তারের<br/>তথ্য এখানে আসবে।</p>
            </div>
          </div>

          {/* Column 4: Web Panel */}
          <div className="bg-white rounded-[2rem] md:rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col h-[300px] md:h-auto overflow-hidden transition-all hover:shadow-xl hover:shadow-emerald-500/5">
            <div className="p-5 md:p-7 border-b border-slate-50 flex items-center gap-2.5 md:gap-3">
              <div className="w-2 md:w-2.5 h-2 md:h-2.5 rounded-full bg-[#3b82f6]"></div>
              <h3 className="font-black text-[#1e293b] text-xs md:text-sm uppercase tracking-widest">ওয়েবসাইট ও বিস্তারিত</h3>
            </div>
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-slate-400 opacity-30">
               <div className="scale-[2] md:scale-[2.8] mb-6 md:mb-10 text-blue-500">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
               </div>
               <p className="text-[10px] md:text-xs font-black uppercase tracking-widest text-center px-4 leading-relaxed">টেস্টের খরচ বা প্রস্তুতির নিয়ম<br/>এখানে দেখা যাবে।</p>
            </div>
          </div>

        </main>
      ) : (
        /* Admin View */
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 md:p-12 animate-in fade-in duration-500">
          {!isAdminAuthenticated ? (
            <div className="max-w-md mx-auto mt-10 md:mt-20 bg-white p-8 md:p-12 rounded-[2rem] md:rounded-[3rem] shadow-2xl border border-slate-100">
              <h2 className="text-2xl md:text-3xl font-black text-[#1e293b] text-center mb-8 md:mb-10">অ্যাডমিন লগইন</h2>
              <form onSubmit={handleAdminLogin} className="space-y-6 md:space-y-7">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-4">পাসওয়ার্ড</label>
                  <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="admin123" className="w-full px-6 py-4 bg-[#f8fafc] border border-slate-100 rounded-2xl text-sm font-bold focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all" required />
                </div>
                {loginError && <p className="text-red-500 text-xs font-black text-center">{loginError}</p>}
                <button className="w-full py-4.5 md:py-5 bg-[#1e293b] text-white rounded-[1.5rem] md:rounded-3xl font-black uppercase tracking-widest text-xs shadow-xl hover:bg-slate-800 transition-all active:scale-95">লগইন করুন</button>
              </form>
            </div>
          ) : (
            <div className="space-y-6 md:space-y-10">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl md:text-3xl font-black text-[#1e293b]">অ্যাডমিন ড্যাশবোর্ড</h2>
                  <p className="text-[10px] md:text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">সিস্টেম কনফিগারেশন ও ডেটা ম্যানেজমেন্ট</p>
                </div>
                <button onClick={handleAdminLogout} className="w-fit px-6 py-2.5 bg-red-50 text-red-600 rounded-xl text-[10px] md:text-xs font-black uppercase tracking-widest border border-red-100 hover:bg-red-100 transition-all">লগআউট</button>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                <div className="bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[2.5rem] border border-slate-100 shadow-sm transition-all">
                   <div className="flex items-center gap-3 md:gap-4 mb-6 md:mb-8">
                     <div className="p-2.5 md:p-3 bg-emerald-50 text-emerald-600 rounded-xl">{ICON_SETTINGS}</div>
                     <h4 className="text-[11px] md:text-sm font-black uppercase tracking-widest text-[#1e293b]">এপিআই কনফিগারেশন</h4>
                   </div>
                   <div className={`p-4 md:p-5 rounded-xl md:rounded-2xl border mb-6 md:mb-8 ${isKeyAvailable ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                      <p className="text-[10px] font-black uppercase tracking-widest mb-1 opacity-60">কারেন্ট স্ট্যাটাস</p>
                      <p className="text-xs md:text-sm font-bold">{isKeyAvailable ? 'Gemini API সংযুক্ত আছে' : 'এপিআই কি ব্রাউজারে সেট করুন'}</p>
                   </div>
                   <button onClick={handleKeySelection} className="w-full py-4 bg-[#059669] text-white rounded-2xl font-black text-[10px] md:text-xs uppercase tracking-widest shadow-lg shadow-emerald-100 hover:bg-[#047857] transition-all">এপিআই কি আপডেট করুন</button>
                </div>

                <div className="bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col transition-all">
                   <div className="flex items-center gap-3 md:gap-4 mb-6 md:mb-8">
                     <div className="p-2.5 md:p-3 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                     </div>
                     <h4 className="text-[11px] md:text-sm font-black uppercase tracking-widest text-[#1e293b]">সংগৃহীত রোগীর তালিকা</h4>
                   </div>
                   <div className="flex-1 overflow-y-auto max-h-[300px] pr-2 custom-scrollbar">
                     <table className="w-full text-left">
                       <tbody className="divide-y divide-slate-50">
                         {patients.length === 0 ? (
                           <tr><td className="py-10 text-center text-slate-400 italic font-medium opacity-60 text-xs">এখনও কোনো ডেটা নেই।</td></tr>
                         ) : patients.map(p => (
                           <tr key={p.id} className="group transition-colors hover:bg-slate-50">
                             <td className="py-4 pr-2">
                               <p className="text-xs md:text-sm font-black text-[#1e293b]">{p.name}</p>
                               <p className="text-[10px] md:text-[11px] text-slate-400 font-bold">{p.phone}</p>
                             </td>
                             <td className="py-4 text-right">
                               <button onClick={() => deleteLead(p.id)} className="text-red-400 hover:text-red-600 text-[10px] font-black uppercase tracking-widest p-2 transition-all opacity-80 md:opacity-0 md:group-hover:opacity-100">মুছে ফেলুন</button>
                             </td>
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
      
      <footer className="w-full bg-white border-t border-slate-100 py-6 md:py-8 text-center mt-auto px-4">
        <p className="text-slate-400 text-[9px] md:text-[10px] font-black uppercase tracking-[0.1em] md:tracking-[0.2em] opacity-60 leading-relaxed">
          © ২০২৬ হেলথ সাপোর্ট সেন্টার | এআই নিরা ২.৯.২-বুকিং-কনফার্মেশন
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>
    </div>
  );
};

export default App;
