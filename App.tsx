
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
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  
  // অ্যাডমিন অথেন্টিকেশন
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(false);
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');

  // অ্যাডমিন ডেটা
  const [patients, setPatients] = useState<PatientRecord[]>([]);

  // মাউন্টের সময় ডেটা লোড করা
  useEffect(() => {
    const saved = localStorage.getItem('nira_leads');
    if (saved) {
      try {
        setPatients(JSON.parse(saved));
      } catch (e) {
        console.error("ডেটা লোড করতে ব্যর্থ", e);
      }
    }
    const auth = localStorage.getItem('nira_admin_auth');
    if (auth === 'true') setIsAdminAuthenticated(true);
  }, []);

  // স্টোরেজে ডেটা সেভ করা
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
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => console.warn('জিওলোকেশন পাওয়া যায়নি', err)
      );
    }
  }, []);

  useEffect(() => {
    if (view === 'assistant') {
      lastTranscriptionRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptions, view]);

  // এপিআই কি সিলেকশন হ্যান্ডলার
  const handleKeySelection = async () => {
    const aistudio = (window as any).aistudio;
    if (aistudio && typeof aistudio.openSelectKey === 'function') {
      await aistudio.openSelectKey();
      return true;
    }
    return false;
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

  const addTranscription = useCallback((role: 'user' | 'nira', text: string) => {
    if (!text.trim()) return;
    setTranscriptions(prev => [
      ...prev,
      { role, text, timestamp: Date.now() }
    ]);
  }, []);

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
    return "তথ্য সফলভাবে সংরক্ষিত হয়েছে।";
  };

  const handleStopCall = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    audioSourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    setStatus(CallStatus.IDLE);
  }, []);

  const performMapsSearch = async (category: string) => {
    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key missing");
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `${category} খুঁজুন বাংলায়। সংক্ষিপ্ত বিবরণ দিন।`;
      const config: any = { tools: [{ googleMaps: {} }] };
      if (userCoords) {
        config.toolConfig = { retrievalConfig: { latLng: { latitude: userCoords.lat, longitude: userCoords.lng } } };
      }
      const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config });
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const results: ResourceResult[] = chunks.filter((c: any) => c.maps).map((c: any) => ({ title: c.maps.title, uri: c.maps.uri }));
      setMapResults(prev => [...results, ...prev].slice(0, 10));
      return { status: "success", found: results.length, text: response.text };
    } catch (err: any) {
      console.error("Maps Search Error:", err);
      return { status: "error", message: "ম্যাপ সার্চে ত্রুটি হয়েছে" };
    }
  };

  const performWebSearch = async (query: string) => {
    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key missing");
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: query,
        config: { tools: [{ googleSearch: {} }] },
      });
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const results: ResourceResult[] = chunks.filter((c: any) => c.web).map((c: any) => ({ title: c.web.title, uri: c.web.uri }));
      setWebResults(prev => [...results, ...prev].slice(0, 10));
      return { status: "success", found: results.length, text: response.text };
    } catch (err: any) {
      console.error("Web Search Error:", err);
      return { status: "error", message: "ওয়েব সার্চে ত্রুটি হয়েছে" };
    }
  };

  const handleStartCall = async () => {
    try {
      // ব্রাউজারে এপিআই কি সেট করা না থাকলে সিলেকশন ডায়ালগ ওপেন করা
      const apiKey = process.env.API_KEY;
      const aistudio = (window as any).aistudio;
      
      if (!apiKey && aistudio) {
        const hasKey = await aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await handleKeySelection();
          // কি সিলেক্ট করার পর প্রসেস করার জন্য কিছুটা সময় বা ইউজার অ্যাকশন প্রয়োজন হতে পারে, 
          // তবে গাইডলাইন অনুযায়ী আমরা ধরে নিচ্ছি কি সফলভাবে সিলেক্ট হয়েছে।
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

      // কি পুনরায় চেক করা (ইনজেকশন হওয়ার পর)
      const currentApiKey = process.env.API_KEY;
      if (!currentApiKey) {
        throw new Error("এপিআই কি (API Key) পাওয়া যায়নি। দয়া করে অ্যাডমিন বা এআই স্টুডিও সেটিং চেক করুন।");
      }

      const ai = new GoogleGenAI({ apiKey: currentApiKey });
      
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
                if (fc.name === 'searchNearbyHealthcare') toolResponse = await performMapsSearch((fc.args as any).category);
                if (fc.name === 'searchWebHealthcare') toolResponse = await performWebSearch((fc.args as any).query);
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

            if (message.serverContent?.outputTranscription) currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            if (message.serverContent?.inputTranscription) currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;

            if (message.serverContent?.turnComplete) {
              addTranscription('user', currentInputTranscriptionRef.current);
              addTranscription('nira', currentOutputTranscriptionRef.current);
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
              }
            }
          },
          onerror: (e) => {
            console.error("Live Error:", e);
            setError("সংযোগ বিচ্ছিন্ন হয়েছে। এপিআই কি অথবা ইন্টারনেট কানেকশন চেক করুন।");
            handleStopCall();
          },
          onclose: () => handleStopCall(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: [SEARCH_TOOL, WEB_SEARCH_TOOL, SAVE_PATIENT_TOOL] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error("Call Error:", err);
      setError(err.message || 'সংযোগ স্থাপনে ত্রুটি হয়েছে');
      setStatus(CallStatus.ERROR);
    }
  };

  const deleteLead = (id: string) => {
    setPatients(prev => prev.filter(p => p.id !== id));
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 overflow-x-hidden font-sans text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-30 w-full bg-white/90 backdrop-blur-xl border-b border-slate-200 px-4 md:px-8 py-4 shadow-sm transition-all">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-100 shrink-0 transform hover:rotate-3 transition-transform">
              {ICON_HEART}
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-black text-slate-900 leading-tight tracking-tight">হেলথ কানেক্ট</h1>
              <p className="text-xs md:text-sm text-slate-500 font-bold uppercase tracking-widest opacity-70">এআই সহকারী: নিরা</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
             <button 
              onClick={() => setView(view === 'assistant' ? 'admin' : 'assistant')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all shadow-sm ${
                view === 'admin' 
                ? 'bg-emerald-600 text-white hover:bg-emerald-700' 
                : 'bg-white border border-slate-200 text-slate-700 hover:border-emerald-500'
              }`}
            >
              {view === 'admin' ? ICON_LAYOUT : ICON_SETTINGS}
              <span className="hidden sm:inline">{view === 'admin' ? 'সহকারী প্যানেল' : 'অ্যাডমিন প্যানেল'}</span>
            </button>
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-emerald-100 text-emerald-700 rounded-full text-[10px] font-black tracking-widest">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping"></div>
              অনলাইন
            </div>
          </div>
        </div>
      </header>

      {view === 'assistant' ? (
        <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-8 flex flex-col lg:grid lg:grid-cols-12 gap-8 items-start animate-in fade-in slide-in-from-bottom-4 duration-500">
          {/* Call Panel */}
          <div className="w-full lg:col-span-4 xl:col-span-3 bg-white rounded-[2.5rem] shadow-2xl p-8 flex flex-col items-center justify-center min-h-[400px] border border-slate-100 transition-all hover:shadow-emerald-100/50">
            <div className="relative mb-8">
              <div className={`w-32 h-32 md:w-40 md:h-40 rounded-full flex items-center justify-center transition-all duration-700 ${
                status === CallStatus.ACTIVE ? 'bg-emerald-100/50' : 'bg-slate-50'
              }`}>
                <div className={`w-24 h-24 md:w-32 md:h-32 rounded-full flex items-center justify-center transition-all duration-300 transform ${
                  status === CallStatus.ACTIVE ? 'bg-emerald-600 shadow-2xl shadow-emerald-200 text-white rotate-0' : 'bg-slate-200 text-slate-400 -rotate-6 hover:rotate-0'
                }`}>
                  {status === CallStatus.ACTIVE ? (
                    <div className="flex gap-1.5 items-end">
                      <div className="w-1.5 h-6 bg-white rounded-full animate-[bounce_1s_infinite]"></div>
                      <div className="w-1.5 h-12 bg-white rounded-full animate-[bounce_1.2s_infinite]"></div>
                      <div className="w-1.5 h-8 bg-white rounded-full animate-[bounce_0.8s_infinite]"></div>
                      <div className="w-1.5 h-10 bg-white rounded-full animate-[bounce_1.1s_infinite]"></div>
                    </div>
                  ) : (
                    <div className="scale-125 md:scale-150">{ICON_MIC}</div>
                  )}
                </div>
              </div>
              {status === CallStatus.CONNECTING && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-full h-full border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              )}
            </div>

            <div className="text-center mb-8 px-2">
              <h2 className="text-xl md:text-2xl font-black text-slate-800 mb-2">
                {status === CallStatus.IDLE && "সহায়তার জন্য প্রস্তুত"}
                {status === CallStatus.CONNECTING && "সংযোগ স্থাপন করা হচ্ছে..."}
                {status === CallStatus.ACTIVE && "নিরা শুনছে..."}
                {status === CallStatus.ERROR && "সংযোগ ত্রুটি"}
              </h2>
              <p className="text-slate-500 text-sm leading-relaxed max-w-xs mx-auto font-medium">
                {status === CallStatus.IDLE && "নিরার সাথে নিরাপদ ভয়েস কনসালটেশন শুরু করতে নিচের বোতামটি ক্লিক করুন।"}
                {status === CallStatus.ACTIVE && "স্পষ্টভাবে বাংলায় কথা বলুন। আমি অ্যাপয়েন্টমেন্ট বুক করতে বা ল্যাব খুঁজে দিতে পারি।"}
                {status === CallStatus.ERROR && (error || "একটি অপ্রত্যাশিত ত্রুটি ঘটেছে।")}
              </p>
            </div>

            <button
              onClick={status === CallStatus.ACTIVE ? handleStopCall : handleStartCall}
              className={`w-full group flex items-center justify-center gap-4 px-8 py-5 rounded-3xl font-black text-lg shadow-xl transition-all active:scale-95 transform hover:-translate-y-1 ${
                status === CallStatus.ACTIVE 
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-200' 
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-200'
              }`}
            >
              <div className={`${status === CallStatus.ACTIVE ? 'bg-red-400/30' : 'bg-emerald-500/30'} p-2.5 rounded-xl shrink-0 transition-colors`}>
                {status === CallStatus.ACTIVE ? ICON_PHONE_OFF : ICON_MIC}
              </div>
              <span>{status === CallStatus.ACTIVE ? 'কল শেষ করুন' : 'কল শুরু করুন'}</span>
            </button>

            {status === CallStatus.ERROR && (window as any).aistudio && (
              <button 
                onClick={handleKeySelection}
                className="mt-4 text-xs font-bold text-emerald-600 underline hover:text-emerald-700"
              >
                এপিআই কি সেট করুন
              </button>
            )}
          </div>

          {/* Assistant Intelligence Area */}
          <div className="w-full lg:col-span-8 xl:col-span-9 flex flex-col gap-6">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              
              {/* Live Transcript Panel */}
              <div className="bg-white rounded-[2rem] shadow-xl border border-slate-100 flex flex-col h-[450px] overflow-hidden group">
                <div className="p-6 border-b border-slate-50 flex items-center justify-between shrink-0 bg-slate-50/50">
                  <h3 className="font-black text-slate-800 flex items-center gap-2 text-sm uppercase tracking-wider">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    লাইভ কথোপকথন
                  </h3>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-white">
                  {transcriptions.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-4 opacity-40 grayscale group-hover:grayscale-0 transition-all text-center">
                       <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto">
                          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                       </div>
                       <p className="text-xs font-black uppercase tracking-widest px-4">আপনার কথোপকথন এখানে দেখা যাবে</p>
                    </div>
                  ) : (
                    transcriptions.map((t, i) => (
                      <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in slide-in-from-bottom-2`}>
                        <div className={`max-w-[90%] rounded-2xl p-4 text-sm font-medium leading-relaxed shadow-sm border ${
                          t.role === 'user' 
                            ? 'bg-emerald-600 text-white rounded-br-none border-emerald-500' 
                            : 'bg-white text-slate-700 rounded-bl-none border-slate-100'
                        }`}>
                          {t.text}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={lastTranscriptionRef} />
                </div>
              </div>

              {/* Maps Results Panel */}
              <div className="bg-white rounded-[2rem] shadow-xl border border-slate-100 flex flex-col h-[450px] overflow-hidden group">
                <div className="p-6 border-b border-slate-50 shrink-0 bg-slate-50/50">
                  <h3 className="font-black text-slate-800 flex items-center gap-2 text-sm uppercase tracking-wider">
                    {ICON_MAP_PIN} ম্যাপ তথ্য
                  </h3>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-3">
                  {mapResults.length === 0 ? (
                     <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-4 opacity-40 text-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto">
                           <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        </div>
                        <p className="text-xs font-black uppercase tracking-widest px-4">লোকেশন ডেটা এখানে পাওয়া যাবে</p>
                     </div>
                  ) : (
                    mapResults.map((res, i) => (
                      <a 
                        key={i} href={res.uri} target="_blank" rel="noopener noreferrer"
                        className="block p-4 rounded-2xl bg-white border border-slate-100 hover:border-emerald-500 hover:shadow-lg transition-all group"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <span className="text-sm font-bold text-slate-800 group-hover:text-emerald-700">{res.title}</span>
                          <div className="shrink-0 p-1.5 bg-slate-50 rounded-lg">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                          </div>
                        </div>
                      </a>
                    ))
                  )}
                </div>
              </div>

              {/* Web Search Panel */}
              <div className="bg-white rounded-[2rem] shadow-xl border border-slate-100 flex flex-col h-[450px] overflow-hidden group">
                <div className="p-6 border-b border-slate-50 shrink-0 bg-slate-50/50">
                  <h3 className="font-black text-slate-800 flex items-center gap-2 text-sm uppercase tracking-wider">
                    {ICON_GLOBE} ওয়েব তথ্য
                  </h3>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-3">
                  {webResults.length === 0 ? (
                     <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-4 opacity-40 text-center">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto">
                           <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
                        </div>
                        <p className="text-xs font-black uppercase tracking-widest px-4">ডায়াগনস্টিক তথ্য এখানে দেখা যাবে</p>
                     </div>
                  ) : (
                    webResults.map((res, i) => (
                      <a 
                        key={i} href={res.uri} target="_blank" rel="noopener noreferrer"
                        className="block p-4 rounded-2xl bg-white border border-slate-100 hover:border-blue-500 hover:shadow-lg transition-all group"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <span className="text-sm font-bold text-blue-900">{res.title}</span>
                          <div className="shrink-0 p-1.5 bg-blue-50 rounded-lg">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                          </div>
                        </div>
                      </a>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Emergency Alert Section */}
            <div className="bg-red-50 rounded-[2rem] p-8 border border-red-100 shadow-lg shadow-red-50/50">
              <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
                <div className="p-4 bg-white rounded-2xl shadow-md text-red-600 shrink-0 transform hover:scale-110 transition-transform">
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12" y1="17" y2="17.01"/></svg>
                </div>
                <div className="text-center sm:text-left">
                  <h4 className="font-black text-red-900 mb-2 uppercase text-xs tracking-widest flex items-center justify-center sm:justify-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-ping"></span>
                    জরুরি প্রোটোকল
                  </h4>
                  <p className="text-red-800 text-sm md:text-base leading-relaxed font-bold">
                    যদি আপনার বুকে ব্যথা বা তীব্র শ্বাসকষ্ট হয়, তবে এখনই কল কেটে <span className="underline decoration-2 underline-offset-4 font-black">৯০০</span> নম্বরে কল করুন।
                  </p>
                </div>
              </div>
            </div>
          </div>
        </main>
      ) : (
        /* Admin View Logic */
        <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-8 animate-in fade-in slide-in-from-top-4 duration-500">
           {!isAdminAuthenticated ? (
             /* Login Screen */
             <div className="max-w-md mx-auto mt-20 bg-white p-10 rounded-[2.5rem] shadow-2xl border border-slate-100">
                <div className="text-center mb-8">
                   <div className="w-16 h-16 bg-slate-900 rounded-2xl flex items-center justify-center text-white mx-auto mb-4">
                      {ICON_SETTINGS}
                   </div>
                   <h2 className="text-2xl font-black text-slate-900">অ্যাডমিন লগইন</h2>
                   <p className="text-sm text-slate-500 font-medium">প্যানেল এক্সেস করতে পাসওয়ার্ড দিন</p>
                </div>
                <form onSubmit={handleAdminLogin} className="space-y-6">
                   <div>
                      <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">পাসওয়ার্ড</label>
                      <input 
                        type="password" 
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="পাসওয়ার্ড লিখুন"
                        className="w-full px-5 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                        required
                      />
                      {loginError && <p className="text-red-500 text-xs mt-2 font-bold">{loginError}</p>}
                   </div>
                   <button className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-black transition-all transform active:scale-95">
                      লগইন করুন
                   </button>
                </form>
                <p className="text-center mt-6 text-[10px] text-slate-400 font-bold uppercase tracking-widest">ডিফল্ট: admin123</p>
             </div>
           ) : (
             /* Admin Dashboard */
             <div className="flex flex-col gap-8">
                <div className="flex items-center justify-between">
                   <h2 className="text-2xl font-black text-slate-900">অ্যাডমিন ড্যাশবোর্ড</h2>
                   <button 
                     onClick={handleAdminLogout}
                     className="px-4 py-2 bg-red-50 text-red-600 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-red-100 transition-all"
                   >
                     লগআউট
                   </button>
                </div>

                {/* Stats Overview */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                   <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                      <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">মোট রোগী</p>
                      <h3 className="text-3xl font-black text-slate-900">{patients.length}</h3>
                   </div>
                   <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                      <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">সক্রিয় এআই</p>
                      <h3 className="text-xl font-black text-emerald-600">Gemini 2.5 Flash</h3>
                   </div>
                   <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                      <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">ChatGPT সিস্টেম</p>
                      <h3 className="text-xl font-black text-slate-400 italic">প্রস্তুত</h3>
                   </div>
                   <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
                      <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">সার্ভার ল্যাটেন্সি</p>
                      <h3 className="text-3xl font-black text-slate-900">৩৮ মিলি-সেকেন্ড</h3>
                   </div>
                </div>

                {/* Data Table */}
                <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 overflow-hidden">
                   <div className="p-8 border-b border-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-50/30">
                      <h3 className="text-xl font-black text-slate-900 flex items-center gap-3">
                         {ICON_USERS} রোগীর তালিকা
                      </h3>
                   </div>
                   <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                         <thead>
                            <tr className="bg-slate-50/50">
                               <th className="p-6 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">রোগীর নাম</th>
                               <th className="p-6 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">যোগাযোগ তথ্য</th>
                               <th className="p-6 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">সংগ্রহের সময়</th>
                               <th className="p-6 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">অবস্থা</th>
                               <th className="p-6 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-100 text-right">অ্যাকশন</th>
                            </tr>
                         </thead>
                         <tbody className="divide-y divide-slate-50">
                            {patients.length === 0 ? (
                               <tr>
                                  <td colSpan={5} className="p-12 text-center text-slate-400 font-medium italic">এখনও কোনো ডেটা সংগ্রহ করা হয়নি।</td>
                               </tr>
                            ) : (
                               patients.map((p) => (
                                  <tr key={p.id} className="hover:bg-slate-50/50 transition-colors group">
                                     <td className="p-6 border-b border-slate-50">
                                        <span className="text-sm font-bold text-slate-900">{p.name}</span>
                                     </td>
                                     <td className="p-6 border-b border-slate-50">
                                        <div className="flex flex-col gap-0.5">
                                           <span className="text-xs font-bold text-slate-700">{p.phone}</span>
                                           <span className="text-xs text-slate-500">{p.email}</span>
                                        </div>
                                     </td>
                                     <td className="p-6 border-b border-slate-50">
                                        <span className="text-xs font-medium text-slate-500">{new Date(p.timestamp).toLocaleString('bn-BD')}</span>
                                     </td>
                                     <td className="p-6 border-b border-slate-50">
                                        <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-full text-[10px] font-black uppercase tracking-tighter">নতুন লিড</span>
                                     </td>
                                     <td className="p-6 border-b border-slate-50 text-right">
                                        <button 
                                          onClick={() => deleteLead(p.id)}
                                          className="text-slate-300 hover:text-red-500 transition-colors p-2 rounded-lg hover:bg-white"
                                        >
                                           <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                                        </button>
                                     </td>
                                  </tr>
                               ))
                            )}
                         </tbody>
                      </table>
                   </div>
                </div>

                {/* API Connectivity Simulator */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                   <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-xl">
                      <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-6 flex items-center gap-3">
                         {ICON_SETTINGS} Google Gemini এপিআই
                      </h4>
                      <div className="space-y-4">
                         <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                            <div>
                               <p className="text-xs font-black text-emerald-900 uppercase tracking-tighter">স্ট্যাটাস</p>
                               <p className="text-sm text-emerald-700 font-bold">সংযুক্ত এবং নিরাপদ</p>
                            </div>
                            <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse shadow-lg shadow-emerald-200"></div>
                         </div>
                         <button 
                            onClick={handleKeySelection}
                            className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition-all"
                         >
                            এপিআই কি পরিবর্তন করুন
                         </button>
                      </div>
                   </div>

                   <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-xl">
                      <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-6 flex items-center gap-3">
                         <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>
                         Chat GPT এপিআই
                      </h4>
                      <p className="text-xs text-slate-500 mb-6 font-medium">OpenAI সিস্টেম কানেক্ট করার জন্য আপনার এপিআই কি দিন।</p>
                      <div className="flex gap-2">
                        <input type="text" placeholder="sk-..." className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs" />
                        <button className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-black transition-colors">
                           সংযুক্ত করুন
                        </button>
                      </div>
                   </div>
                </div>
             </div>
           )}
        </main>
      )}

      {/* Footer */}
      <footer className="w-full bg-white border-t border-slate-200 mt-8 relative z-10">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-6 text-center md:text-left">
          <div className="text-slate-500 text-xs md:text-sm font-bold uppercase tracking-widest opacity-60">
            <p>© ২০২৬ হেলথ সাপোর্ট সেন্টার। আপনার তথ্য নিরাপদ।</p>
          </div>
          <div className="flex flex-col md:items-end gap-2">
            <div className="px-4 py-1 bg-slate-900 rounded-lg text-[10px] font-black text-white tracking-widest transform -skew-x-12">
              JRRTECH এন্টারপ্রাইজ
            </div>
            <p className="text-[10px] text-slate-400 font-bold tracking-widest uppercase">সংস্করণ: ২.৫.০-বাংলা-সুরক্ষিত</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
