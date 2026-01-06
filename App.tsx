
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { CallStatus, TranscriptionEntry, PatientRecord, AppView, CallHistoryEntry } from './types.ts';
import { decode, decodeAudioData, createBlob } from './audioUtils.ts';
import { 
  SYSTEM_PROMPT, SAVE_PATIENT_TOOL, WEB_SEARCH_TOOL,
  ICON_MIC, ICON_PHONE_OFF, ICON_HEART, ICON_SETTINGS, ICON_INFO, ICON_CLOCK, ICON_TRASH 
} from './constants.tsx';

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('assistant');
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [activeUserText, setActiveUserText] = useState('');
  const [activeNiraText, setActiveNiraText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastSavedPatient, setLastSavedPatient] = useState<string | null>(null);
  const [webResults, setWebResults] = useState<{title: string, snippet: string}[]>([]);
  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([]);
  
  // Admin state
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(false);
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [patients, setPatients] = useState<PatientRecord[]>([]);

  const isKeyAvailable = !!process.env.API_KEY;

  useEffect(() => {
    const savedLeads = localStorage.getItem('nira_leads');
    if (savedLeads) {
      try { setPatients(JSON.parse(savedLeads)); } catch (e) { console.error("Data load failed", e); }
    }
    const savedHistory = localStorage.getItem('nira_call_history');
    if (savedHistory) {
      try { setCallHistory(JSON.parse(savedHistory)); } catch (e) { console.error("History load failed", e); }
    }
    const auth = localStorage.getItem('nira_admin_auth');
    if (auth === 'true') setIsAdminAuthenticated(true);
  }, []);

  useEffect(() => {
    localStorage.setItem('nira_leads', JSON.stringify(patients));
  }, [patients]);

  useEffect(() => {
    localStorage.setItem('nira_call_history', JSON.stringify(callHistory));
  }, [callHistory]);

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

  const generateSummary = async (transcript: TranscriptionEntry[]): Promise<string> => {
    if (transcript.length < 2) return "সংক্ষিপ্ত কথা হয়েছে।";
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `Summarize the following medical assistant conversation in exactly one sentence in Bengali. Focus on the main concern or request: \n\n ${transcript.map(t => `${t.role}: ${t.text}`).join('\n')}`;
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt
      });
      return response.text?.trim() || "কথোপকথনের সারাংশ পাওয়া যায়নি।";
    } catch (e) {
      console.error("Summary generation failed", e);
      return "সারাংশ তৈরি করা সম্ভব হয়নি।";
    }
  };

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
    setTimeout(() => setLastSavedPatient(null), 10000); 
    return "সফলভাবে সংরক্ষিত। রোগীকে বলুন: 'আপনার তথ্য সফলভাবে সংরক্ষিত হয়েছে। আমাদের একজন প্রতিনিধি শীঘ্রই আপনার সাথে যোগাযোগ করবেন।'";
  };

  const deleteLead = (id: string) => setPatients(prev => prev.filter(p => p.id !== id));
  const deleteHistory = (id: string) => setCallHistory(prev => prev.filter(h => h.id !== id));

  const handleStopCall = useCallback(async () => {
    if (transcriptions.length > 0) {
      const currentTranscript = [...transcriptions];
      const newHistoryEntry: CallHistoryEntry = {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        summary: "সারাংশ তৈরি হচ্ছে...",
        transcript: currentTranscript
      };
      setCallHistory(prev => [newHistoryEntry, ...prev]);
      
      generateSummary(currentTranscript).then(summary => {
        setCallHistory(prev => prev.map(h => h.id === newHistoryEntry.id ? { ...h, summary } : h));
      });
    }

    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    if (scriptProcessorRef.current) { scriptProcessorRef.current.disconnect(); scriptProcessorRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
    audioSourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setStatus(CallStatus.IDLE);
    setTranscriptions([]);
    setActiveUserText('');
    setActiveNiraText('');
    currentInputAcc.current = '';
    currentOutputAcc.current = '';
  }, [transcriptions]);

  const handleStartCall = async () => {
    try {
      const aistudio = (window as any).aistudio;
      if (aistudio) {
        const hasKey = await aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await aistudio.openSelectKey();
        }
      }

      if (!process.env.API_KEY && (!aistudio || !(await aistudio.hasSelectedApiKey()))) {
         if (aistudio) {
            await aistudio.openSelectKey();
         } else {
            setError("API Key is required to start.");
            setStatus(CallStatus.ERROR);
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
                } else if (fc.name === 'searchWebHealthcare') {
                  const args = fc.args as any;
                  const query = args.query.toLowerCase();
                  
                  let costRange = "৫০০ - ২০০০ টাকা";
                  let preparation = "তেমন কোনো বিশেষ প্রস্তুতির প্রয়োজন নেই।";
                  
                  if (query.includes("mri")) {
                    costRange = "৪০০০ - ১৫০০০ টাকা (অঙ্গভেদে পরিবর্তিত হতে পারে)";
                    preparation = "শরীরে কোনো ধাতব বস্তু রাখা যাবে না। টেস্টের ৪-৬ ঘণ্টা আগে খাবার না খাওয়াই ভালো।";
                  } else if (query.includes("blood") || query.includes("রক্ত")) {
                    costRange = "৩০০ - ১০০০ টাকা";
                    preparation = "বেশিরভাগ ক্ষেত্রে ৮-১২ ঘণ্টা খালি পেটে থাকতে হয়। সকালে পানি পান করা যাবে।";
                  } else if (query.includes("x-ray") || query.includes("এক্স-রে")) {
                    costRange = "৪০০ - ৮০০ টাকা";
                    preparation = "গর্ভবতী মহিলাদের ক্ষেত্রে ডাক্তারকে আগে জানাতে হবে। অলংকার বা মেটাল সরিয়ে রাখতে হবে।";
                  } else if (query.includes("ct scan") || query.includes("সিটি স্ক্যান")) {
                    costRange = "৩৫০০ - ৮০০০ টাকা";
                    preparation = "ডাই (Contrast) ব্যবহার করলে ৪ ঘণ্টা খালি পেটে থাকতে হবে। কিডনির সমস্যার ইতিহাস থাকলে জানাতে হবে।";
                  }

                  const mockResults = [
                    {title: `Information for: ${args.query}`, snippet: `সম্ভাব্য খরচ: ${costRange}। প্রস্তুতির নিয়ম: ${preparation}`},
                    {title: `Healthcare Tips for ${args.query}`, snippet: "সঠিক ফলাফলের জন্য অনুমোদিত ল্যাবরেটরি থেকে টেস্ট করানো উচিত। আপনার ডাক্তারের পরামর্শ মেনে চলুন।"}
                  ];
                  setWebResults(mockResults);
                  toolResponse = { results: mockResults, status: "Success", details: { cost: costRange, prep: preparation } };
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
              currentInputAcc.current += message.serverContent.inputTranscription.text;
              setActiveUserText(currentInputAcc.current);
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputAcc.current += message.serverContent.outputTranscription.text;
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
            console.error("Live Error:", e);
            if (e?.message?.includes("Requested entity was not found")) {
                handleKeySelection();
            }
            setError(e.message || "Connection error. Please check your key.");
            handleStopCall();
          },
          onclose: () => handleStopCall(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: [SAVE_PATIENT_TOOL, WEB_SEARCH_TOOL] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error("Connection error:", err);
      if (err.message?.includes("Requested entity was not found")) {
        handleKeySelection();
      }
      setError(err.message || 'Error connecting to Nira');
      setStatus(CallStatus.ERROR);
    }
  };

  const renderAssistant = () => (
    <main className="flex-1 max-w-[1600px] mx-auto w-full p-4 md:p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in fade-in duration-500">
      <section className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 p-8 flex flex-col items-center justify-center text-center transition-all hover:shadow-xl hover:shadow-emerald-500/5 group relative min-h-[400px]">
        {lastSavedPatient && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 w-[85%] bg-emerald-600 text-white py-3 px-4 rounded-2xl text-[10px] font-black uppercase tracking-wider animate-in slide-in-from-top-4 shadow-xl z-20 flex items-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full animate-ping"></div>
            বুকিং সম্পন্ন: {lastSavedPatient}
          </div>
        )}
        
        <div className={`w-40 h-40 md:w-56 md:h-56 rounded-full flex items-center justify-center mb-10 transition-all duration-700 ${status === CallStatus.ACTIVE ? 'bg-emerald-50 scale-110 shadow-inner' : 'bg-slate-50'}`}>
          <div className={`scale-[2] md:scale-[3] transition-all duration-500 ${status === CallStatus.ACTIVE ? 'text-emerald-600' : 'text-slate-300 group-hover:scale-[3.2]'}`}>
            {status === CallStatus.ACTIVE ? (
              <div className="flex gap-1 items-end">
                <div className="w-2 h-8 bg-emerald-500 rounded-full animate-bounce [animation-duration:1s]"></div>
                <div className="w-2 h-16 bg-emerald-500 rounded-full animate-bounce [animation-duration:0.8s]"></div>
                <div className="w-2 h-10 bg-emerald-500 rounded-full animate-bounce [animation-duration:1.2s]"></div>
              </div>
            ) : ICON_MIC}
          </div>
        </div>
        
        <h2 className="text-xl md:text-2xl font-black mb-3 text-slate-800">
          {status === CallStatus.IDLE && "নিরার সাথে কথা বলুন"}
          {status === CallStatus.CONNECTING && "সংযোগ হচ্ছে..."}
          {status === CallStatus.ACTIVE && "নিরা শুনছে..."}
          {status === CallStatus.ERROR && "সংযোগ ত্রুটি"}
        </h2>
        
        <p className="text-slate-500 text-xs md:text-sm font-medium mb-10 px-4 leading-relaxed opacity-70">
          {status === CallStatus.ERROR ? error : "নিরাপদ ভয়েস কনসালটেশন বা অ্যাপয়েন্টমেন্ট বুকিংয়ের জন্য কল শুরু করুন।"}
        </p>

        <button
          onClick={status === CallStatus.ACTIVE ? handleStopCall : handleStartCall}
          className={`w-full max-w-[280px] flex items-center justify-center gap-4 py-5 rounded-[2rem] font-black text-white transition-all shadow-2xl active:scale-95 transform hover:-translate-y-1 ${status === CallStatus.ACTIVE ? 'bg-red-500 shadow-red-200 hover:bg-red-600' : 'bg-emerald-600 shadow-emerald-200 hover:bg-emerald-700'}`}
        >
          <div className="scale-110">{status === CallStatus.ACTIVE ? ICON_PHONE_OFF : ICON_MIC}</div>
          <span className="tracking-widest uppercase text-xs md:text-sm">{status === CallStatus.ACTIVE ? 'কল শেষ করুন' : 'কল শুরু করুন'}</span>
        </button>
      </section>

      <section className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col h-[500px] md:h-auto overflow-hidden transition-all hover:shadow-xl hover:shadow-emerald-500/5">
        <div className="p-7 border-b border-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
            <h3 className="font-black text-slate-800 text-xs md:text-sm uppercase tracking-widest">লাইভ ট্রান্সক্রিপ্ট</h3>
          </div>
          {status === CallStatus.ACTIVE && <span className="text-[10px] font-bold text-emerald-600 animate-pulse">রেকর্ড হচ্ছে...</span>}
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/30 custom-scrollbar">
          {transcriptions.length === 0 && !activeUserText && !activeNiraText ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-40">
               <div className="scale-[3] mb-10">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
               </div>
               <p className="text-[10px] font-black uppercase tracking-[0.2em] text-center px-6">কথোপকথন এখানে দেখা যাবে</p>
            </div>
          ) : (
            <>
              {transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2`}>
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1 px-2">{t.role === 'user' ? 'আপনি' : 'নিরা'}</span>
                  <div className={`max-w-[90%] rounded-2xl p-4 text-xs md:text-sm font-bold shadow-sm border ${t.role === 'user' ? 'bg-emerald-600 text-white border-emerald-700 rounded-tr-none' : 'bg-white text-slate-700 border-slate-100 rounded-tl-none'}`}>
                    {t.text}
                  </div>
                </div>
              ))}
              {activeUserText && (
                <div className="flex flex-col items-end opacity-70">
                  <div className="max-w-[90%] rounded-2xl p-4 text-xs md:text-sm font-bold bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-tr-none italic animate-pulse">
                    {activeUserText}
                  </div>
                </div>
              )}
              {activeNiraText && (
                <div className="flex flex-col items-start animate-in fade-in">
                   <span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 mb-1 px-2">নিরা বলছে...</span>
                  <div className="max-w-[90%] rounded-2xl p-4 text-xs md:text-sm font-bold bg-white text-slate-500 border border-slate-100 rounded-tl-none shadow-sm flex items-center gap-2">
                    {activeNiraText}
                    <div className="w-1.5 h-4 bg-emerald-400 animate-pulse rounded-full"></div>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={lastTranscriptionRef} />
        </div>
      </section>

      <section className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col h-[300px] md:h-auto overflow-hidden transition-all hover:shadow-xl hover:shadow-emerald-500/5">
        <div className="p-7 border-b border-slate-50 flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400"></div>
          <h3 className="font-black text-slate-800 text-xs md:text-sm uppercase tracking-widest">ম্যাপ লোকেশন</h3>
        </div>
        <div className="flex-1 p-8 flex flex-col items-center justify-center text-slate-300 opacity-40 text-center">
           <div className="scale-[3] mb-12 text-emerald-500/30">
             <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
           </div>
           <p className="text-[10px] font-black uppercase tracking-[0.2em] leading-relaxed px-6">কাছাকাছি হাসপাতাল বা ডায়াগনস্টিক সেন্টারের ম্যাপ এখানে দেখা যাবে</p>
        </div>
      </section>

      <section className="bg-white rounded-[2.5rem] shadow-sm border border-slate-100 flex flex-col h-[400px] md:h-auto overflow-hidden transition-all hover:shadow-xl hover:shadow-emerald-500/5">
        <div className="p-7 border-b border-slate-50 flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div>
          <h3 className="font-black text-slate-800 text-xs md:text-sm uppercase tracking-widest">ওয়েবসাইট ও বিস্তারিত</h3>
        </div>
        <div className="flex-1 p-6 overflow-y-auto custom-scrollbar bg-slate-50/20">
          {webResults.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-40 text-center">
               <div className="scale-[3] mb-12 text-blue-500/30">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
               </div>
               <p className="text-[10px] font-black uppercase tracking-[0.2em] leading-relaxed px-6">টেস্টের খরচ বা প্রস্তুতির নিয়ম এখানে দেখা যাবে</p>
            </div>
          ) : (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
              {webResults.map((res, idx) => (
                <div key={idx} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm hover:border-blue-200 transition-all">
                  <h4 className="text-blue-600 font-black text-xs md:text-sm mb-2">{res.title}</h4>
                  <p className="text-slate-600 text-[11px] md:text-xs font-bold leading-relaxed">{res.snippet}</p>
                </div>
              ))}
              <button 
                onClick={() => setWebResults([])}
                className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-500 transition-all"
              >
                Clear Results
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );

  const renderAdmin = () => (
    <main className="flex-1 max-w-7xl mx-auto w-full p-6 md:p-12 animate-in fade-in duration-500">
      {!isAdminAuthenticated ? (
        <div className="max-w-md mx-auto mt-20 bg-white p-12 rounded-[3rem] shadow-2xl border border-slate-100">
          <h2 className="text-3xl font-black text-slate-800 text-center mb-10">অ্যাডমিন লগইন</h2>
          <form onSubmit={handleAdminLogin} className="space-y-8">
            <div className="space-y-3">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-4">পাসওয়ার্ড</label>
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="admin123" className="w-full px-6 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all" required />
            </div>
            {loginError && <p className="text-red-500 text-xs font-black text-center">{loginError}</p>}
            <button className="w-full py-5 bg-slate-800 text-white rounded-3xl font-black uppercase tracking-widest text-xs shadow-xl hover:bg-slate-700 transition-all">লগইন করুন</button>
          </form>
        </div>
      ) : (
        <div className="space-y-12">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h2 className="text-3xl font-black text-slate-800">অ্যাডমিন ড্যাশবোর্ড</h2>
              <p className="text-[10px] md:text-xs text-slate-400 font-bold uppercase tracking-[0.2em] mt-2">সিস্টেম কনফিগারেশন, সংগৃহীত লিড ও কল হিস্ট্রি</p>
            </div>
            <button onClick={handleAdminLogout} className="px-8 py-3 bg-red-50 text-red-600 rounded-2xl text-xs font-black uppercase tracking-widest border border-red-100 hover:bg-red-100 transition-all">লগআউট</button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {/* Enhanced API Management Card */}
            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col">
               <div className="flex items-center gap-4 mb-8">
                 <div className="p-3 bg-emerald-50 text-emerald-600 rounded-2xl">{ICON_SETTINGS}</div>
                 <h4 className="text-sm font-black uppercase tracking-widest text-slate-700">API ও সিস্টেম কনফিগারেশন</h4>
               </div>
               
               <div className="space-y-6">
                 <div className={`p-5 rounded-2xl border ${isKeyAvailable ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                    <p className="text-[10px] font-black uppercase tracking-widest mb-1 opacity-60">বর্তমান সংযোগ অবস্থা</p>
                    <p className="text-sm font-bold flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${isKeyAvailable ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
                      {isKeyAvailable ? 'API সংযুক্ত আছে' : 'API Key পাওয়া যায়নি'}
                    </p>
                 </div>

                 <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                    <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-600 mb-3">কিভাবে API Key পাবেন:</h5>
                    <ol className="text-[10px] md:text-xs text-slate-500 font-bold list-decimal pl-4 space-y-2">
                      <li><a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-emerald-600 underline">ai.google.dev</a>-এ যান।</li>
                      <li>আপনার Google অ্যাকাউন্টে লগইন করুন।</li>
                      <li>একটি API Key তৈরি করুন (অবশ্যই Paid Project হতে হবে)।</li>
                    </ol>
                 </div>

                 <div className="bg-blue-50 p-5 rounded-2xl border border-blue-100">
                    <h5 className="text-[11px] font-black uppercase tracking-widest text-blue-700 mb-2">Vercel ডেপ্লয়মেন্ট গাইড:</h5>
                    <p className="text-[10px] md:text-xs text-blue-600 font-medium leading-relaxed">
                      প্রোডাকশনে অ্যাপটি ব্যবহারের জন্য আপনার Vercel ড্যাশবোর্ডে যান। 
                      <b>Settings > Environment Variables</b>-এ <code>API_KEY</code> নামে আপনার কি-টি যুক্ত করুন।
                    </p>
                 </div>
               </div>

               <button 
                 onClick={handleKeySelection} 
                 className="mt-8 w-full py-5 bg-emerald-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-emerald-100 hover:bg-emerald-700 transition-all active:scale-95"
               >
                 কি আপডেট করুন (Secure Dialog)
               </button>
            </div>

            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col h-[650px]">
               <div className="flex items-center gap-4 mb-8">
                 <div className="p-3 bg-blue-50 text-blue-600 rounded-2xl"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>
                 <h4 className="text-sm font-black uppercase tracking-widest text-slate-700">সংগৃহীত লিড ({patients.length})</h4>
               </div>
               <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                 <table className="w-full text-left">
                   <tbody className="divide-y divide-slate-50">
                     {patients.length === 0 ? (
                       <tr><td className="py-10 text-center text-slate-300 italic text-xs">কোনো লিড নেই</td></tr>
                     ) : patients.map(p => (
                       <tr key={p.id} className="group">
                         <td className="py-4">
                           <p className="text-sm font-black text-slate-800">{p.name}</p>
                           <p className="text-[11px] text-slate-400 font-bold">{p.phone}</p>
                         </td>
                         <td className="py-4 text-right">
                           <button onClick={() => deleteLead(p.id)} className="text-red-400 hover:text-red-600 p-2 opacity-0 group-hover:opacity-100 transition-all">{ICON_TRASH}</button>
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
            </div>

            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col h-[650px]">
               <div className="flex items-center gap-4 mb-8">
                 <div className="p-3 bg-slate-50 text-slate-600 rounded-2xl">{ICON_CLOCK}</div>
                 <h4 className="text-sm font-black uppercase tracking-widest text-slate-700">কল হিস্ট্রি (অ্যাডমিন)</h4>
               </div>
               <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                 <div className="space-y-4">
                   {callHistory.length === 0 ? (
                     <div className="py-10 text-center text-slate-300 italic text-xs">কোনো কল রেকর্ড নেই</div>
                   ) : callHistory.map(h => (
                     <div key={h.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 relative group">
                        <button onClick={() => deleteHistory(h.id)} className="absolute top-2 right-2 text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all">{ICON_TRASH}</button>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">{new Date(h.timestamp).toLocaleString('bn-BD')}</p>
                        <p className="text-[11px] font-bold text-slate-700 leading-relaxed">{h.summary}</p>
                        <p className="text-[9px] font-black text-emerald-600 uppercase mt-2 tracking-widest">টার্ন সংখ্যা: {h.transcript.length}</p>
                     </div>
                   ))}
                 </div>
               </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );

  const renderHistory = () => (
    <main className="flex-1 max-w-4xl mx-auto w-full p-6 md:p-12 animate-in fade-in duration-500">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h2 className="text-3xl font-black text-slate-800">কল হিস্ট্রি</h2>
          <p className="text-[10px] md:text-xs text-slate-400 font-bold uppercase tracking-[0.2em] mt-2">আপনার সাথে নিরার সকল কথোপকথন</p>
        </div>
        <button onClick={() => setView('assistant')} className="px-6 py-2 bg-emerald-50 text-emerald-600 rounded-xl text-xs font-black uppercase tracking-widest border border-emerald-100 hover:bg-emerald-100 transition-all">ফিরে যান</button>
      </div>

      {callHistory.length === 0 ? (
        <div className="bg-white rounded-[3rem] p-20 flex flex-col items-center justify-center text-center shadow-sm border border-slate-100">
          <div className="scale-[3] mb-12 text-slate-200">{ICON_CLOCK}</div>
          <p className="text-sm font-black uppercase tracking-[0.2em] text-slate-400">এখন পর্যন্ত কোনো কথা হয়নি</p>
          <button onClick={() => setView('assistant')} className="mt-8 px-8 py-4 bg-emerald-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest shadow-lg shadow-emerald-100">কথা বলা শুরু করুন</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {callHistory.map(h => (
            <div key={h.id} className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-xl hover:shadow-emerald-500/5 transition-all group animate-in slide-in-from-bottom-4">
              <div className="flex items-center justify-between mb-6">
                <div className="px-3 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-black rounded-lg uppercase tracking-widest flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></div>
                  কল শেষ
                </div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{new Date(h.timestamp).toLocaleDateString('bn-BD')} | {new Date(h.timestamp).toLocaleTimeString('bn-BD')}</p>
              </div>
              <h4 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2">সারাংশ (Summary)</h4>
              <p className="text-sm md:text-base font-bold text-slate-700 leading-relaxed mb-6">{h.summary}</p>
              <div className="pt-6 border-t border-slate-50 flex items-center justify-between">
                 <button className="text-[10px] font-black uppercase tracking-widest text-emerald-600 hover:opacity-70 flex items-center gap-2 group/btn">
                    বিস্তারিত দেখুন <span className="group-hover/btn:translate-x-1 transition-transform">→</span>
                 </button>
                 <button onClick={() => deleteHistory(h.id)} className="p-2 text-slate-300 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100">
                    {ICON_TRASH}
                 </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );

  const renderGuide = () => (
    <main className="flex-1 max-w-4xl mx-auto w-full p-6 md:p-12 animate-in slide-in-from-bottom-6 duration-700">
      <div className="bg-white rounded-[3rem] shadow-2xl border border-slate-100 overflow-hidden">
        <div className="bg-emerald-600 p-10 md:p-16 text-white">
          <h2 className="text-3xl md:text-5xl font-black mb-4 tracking-tight">ইউজার গাইড</h2>
          <p className="text-emerald-100 font-bold opacity-90 text-sm md:text-base leading-relaxed">সহায়তা সহকারী 'নিরা' এর সকল ফিচার এবং ব্যবহারের নিয়মাবলী এখানে বিস্তারিত আলোচনা করা হয়েছে।</p>
        </div>
        
        <div className="p-8 md:p-16 space-y-12 md:space-y-16">
          <section className="space-y-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center font-black">০১</div>
              <h3 className="text-xl md:text-2xl font-black text-slate-800">অ্যাপয়েন্টমেন্ট বুকিং (Booking)</h3>
            </div>
            <div className="pl-16 space-y-4">
              <p className="text-slate-600 font-bold text-sm leading-relaxed">টেলিমেডিসিন অ্যাপয়েন্টমেন্টের জন্য নিরার সাথে কথা বলুন। বুকিং সম্পন্ন করতে নিচের তথ্যগুলো তৈরি রাখুন:</p>
              <ul className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {['রোগীর পূর্ণ নাম', 'সচল মোবাইল নম্বর', 'ইমেইল ঠিকানা'].map((item, idx) => (
                  <li key={idx} className="bg-slate-50 p-4 rounded-xl text-xs font-black text-slate-700 flex items-center gap-3">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="space-y-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center font-black">০২</div>
              <h3 className="text-xl md:text-2xl font-black text-slate-800">ডায়াগনস্টিক তথ্য (Diagnostics)</h3>
            </div>
            <div className="pl-16 space-y-4">
              <p className="text-slate-600 font-bold text-sm leading-relaxed">যেকোনো মেডিকেল টেস্টের খরচ এবং প্রস্তুতির নিয়ম জানতে নিরাকে জিজ্ঞেস করুন। যেমন:</p>
              <div className="bg-slate-800 p-6 rounded-2xl space-y-3">
                <p className="text-emerald-400 text-xs font-black tracking-widest uppercase">ব্যবহারকারীর উদাহরণ:</p>
                <p className="text-white font-bold italic text-sm md:text-base">"রক্ত পরীক্ষার জন্য কি খালি পেটে থাকতে হবে?"</p>
                <p className="text-white font-bold italic text-sm md:text-base">"ঢাকার ল্যাব এইডে এমআরআই টেস্টের খরচ কত?"</p>
              </div>
            </div>
          </section>

          <section className="space-y-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-slate-50 text-slate-600 rounded-2xl flex items-center justify-center font-black">০৩</div>
              <h3 className="text-xl md:text-2xl font-black text-slate-800">কল হিস্ট্রি (Call History)</h3>
            </div>
            <div className="pl-16 space-y-4">
              <p className="text-slate-600 font-bold text-sm leading-relaxed">আপনার সকল কথোপকথন স্বয়ংক্রিয়ভাবে সংরক্ষিত হয়। ঘড়ি আইকন ({ICON_CLOCK}) এ ক্লিক করে আপনি পূর্বের কলের সারাংশ দেখে নিতে পারেন।</p>
            </div>
          </section>

          <section className="space-y-8 pt-8 border-t border-slate-100">
            <h3 className="text-2xl font-black text-slate-800 text-center">সচরাচর জিজ্ঞাসিত প্রশ্নাবলী (FAQ)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {[
                {q: "নিরা কি বাংলায় কথা বলতে পারে?", a: "হ্যাঁ, নিরা সম্পূর্ণ বাংলায় এবং অত্যন্ত শুদ্ধভাবে আপনার সাথে কথা বলতে সক্ষম।"},
                {q: "মাইক্রোফোন কাজ না করলে কি করব?", a: "ব্রাউজারের সেটিংস থেকে মাইক্রোফোন পারমিশন চেক করুন এবং ইন্টারনেটের স্পিড নিশ্চিত করুন।"},
                {q: "বুকিং ডেটা কোথায় সংরক্ষিত হয়?", a: "আপনার তথ্যসমূহ সাময়িকভাবে লোকাল স্টোরেজে রাখা হয় এবং অ্যাডমিন ড্যাশবোর্ড থেকে তা দেখা যায়।"},
                {q: "নিরা কি ঔষধের নাম বলতে পারে?", a: "না, নিরা কোনো প্রকার মেডিকেল প্রেসক্রিপশন বা ঔষধের নাম পরামর্শ প্রদান করে না।" }
              ].map((faq, idx) => (
                <div key={idx} className="p-6 bg-slate-50 rounded-3xl space-y-3 border border-slate-100 hover:border-emerald-200 transition-all">
                  <h4 className="font-black text-slate-800 text-sm">প্রশ্ন: {faq.q}</h4>
                  <p className="text-xs text-slate-500 font-bold leading-relaxed">উত্তর: {faq.a}</p>
                </div>
              ))}
            </div>
          </section>

          <button onClick={() => setView('assistant')} className="w-full py-5 bg-emerald-600 text-white rounded-3xl font-black uppercase tracking-[0.2em] shadow-xl hover:bg-emerald-700 transition-all">কল করতে ফিরে যান</button>
        </div>
      </div>
    </main>
  );

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 font-sans text-slate-900 overflow-x-hidden selection:bg-emerald-100">
      <header className="w-full bg-white border-b border-slate-200 px-4 md:px-10 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 sticky top-0 z-50">
        <div className="flex items-center gap-4 cursor-pointer" onClick={() => setView('assistant')}>
          <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-100">
            <div className="scale-125 brightness-0 invert">{ICON_HEART}</div>
          </div>
          <div className="flex flex-col">
            <h1 className="text-xl md:text-2xl font-black text-slate-800 tracking-tight leading-none">হেলথ সাপোর্ট</h1>
            <p className="text-[10px] md:text-xs text-slate-500 font-bold uppercase tracking-wider opacity-80 mt-1">ভার্চুয়াল সহকারী: নিরা</p>
          </div>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
          <div className="bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full text-[10px] font-black flex items-center gap-2 shadow-sm border border-emerald-100">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
            অনলাইন
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setView('history')}
              className={`p-3 rounded-xl transition-all ${view === 'history' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}
              title="কল হিস্ট্রি"
            >
              {ICON_CLOCK}
            </button>
            <button 
              onClick={() => setView('guide')}
              className={`p-3 rounded-xl transition-all ${view === 'guide' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}
              title="ইউজার গাইড"
            >
              {ICON_INFO}
            </button>
            <button 
              onClick={() => setView(view === 'admin' ? 'assistant' : 'admin')}
              className={`p-3 rounded-xl transition-all ${view === 'admin' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}
              title="অ্যাডমিন"
            >
              {ICON_SETTINGS}
            </button>
          </div>
        </div>
      </header>

      {view === 'assistant' && renderAssistant()}
      {view === 'admin' && renderAdmin()}
      {view === 'guide' && renderGuide()}
      {view === 'history' && renderHistory()}
      
      <footer className="w-full bg-white border-t border-slate-100 py-8 text-center mt-auto px-6">
        <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.3em] opacity-60">
          © ২০২৬ হেলথ সাপোর্ট সেন্টার | এআই নিরা ২.১২.১-API-গাইড
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-4px); }
          75% { transform: translateX(4px); }
        }
        .animate-shake { animation: shake 0.3s ease-in-out infinite; animation-iteration-count: 2; }
      `}</style>
    </div>
  );
};

export default App;
