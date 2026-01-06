
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { 
  CallStatus, TranscriptionEntry, PatientRecord, AppView, CallHistoryEntry,
  HealthDatabase, DoctorEntry, DiagnosticEntry, HospitalEntry, MedicineEntry, FirstAidEntry
} from './types.ts';
import { decode, decodeAudioData, createBlob } from './audioUtils.ts';
import { 
  SYSTEM_PROMPT, SAVE_PATIENT_TOOL, WEB_SEARCH_TOOL, SEARCH_INTERNAL_TOOL,
  ICON_MIC, ICON_PHONE_OFF, ICON_HEART, ICON_SETTINGS, ICON_INFO, ICON_CLOCK, ICON_TRASH, ICON_DATABASE, ICON_PLUS 
} from './constants.tsx';

const LoadingSpinner = ({ size = "w-6 h-6", color = "text-emerald-500" }) => (
  <div className={`${size} animate-spin`}>
    <svg className={color} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  </div>
);

const App: React.FC = () => {
  const [view, setView] = useState<AppView>('assistant');
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [activeUserText, setActiveUserText] = useState('');
  const [activeNiraText, setActiveNiraText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastSavedPatient, setLastSavedPatient] = useState<string | null>(null);
  const [webResults, setWebResults] = useState<{title: string, snippet: string}[]>([]);
  const [internalResults, setInternalResults] = useState<any[]>([]);
  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([]);
  const [isSearchingWeb, setIsSearchingWeb] = useState(false);
  const [isSearchingInternal, setIsSearchingInternal] = useState(false);
  
  // History Detail State
  const [selectedHistory, setSelectedHistory] = useState<CallHistoryEntry | null>(null);

  // Pending Booking Confirmation
  const [pendingLead, setPendingLead] = useState<{name: string, phone: string, email: string} | null>(null);

  // Admin state
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(false);
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [patients, setPatients] = useState<PatientRecord[]>([]);

  // Health Database state
  const [db, setDb] = useState<HealthDatabase>({
    doctors: [],
    diagnostics: [],
    hospitals: [],
    medicines: [],
    firstAid: []
  });
  const [activeDbTab, setActiveDbTab] = useState<keyof HealthDatabase>('doctors');
  const [isEditing, setIsEditing] = useState<string | null>(null);

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
    const savedDb = localStorage.getItem('nira_health_db');
    if (savedDb) {
      try { setDb(JSON.parse(savedDb)); } catch (e) { console.error("Database load failed", e); }
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

  useEffect(() => {
    localStorage.setItem('nira_health_db', JSON.stringify(db));
  }, [db]);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const lastTranscriptionRef = useRef<HTMLDivElement | null>(null);

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
    return "সফলভাবে সংরক্ষিত।";
  };

  const updateLeadStatus = (id: string, newStatus: PatientRecord['status']) => {
    setPatients(prev => prev.map(p => p.id === id ? { ...p, status: newStatus } : p));
  };

  const deleteLead = (id: string) => setPatients(prev => prev.filter(p => p.id !== id));
  const deleteHistory = (id: string) => {
    setCallHistory(prev => prev.filter(h => h.id !== id));
    if (selectedHistory?.id === id) setSelectedHistory(null);
  };

  // Healthcare DB CRUD
  const upsertDbEntry = (category: keyof HealthDatabase, data: any) => {
    setDb(prev => {
      const list = [...prev[category]];
      if (isEditing) {
        const index = list.findIndex((item: any) => item.id === isEditing);
        if (index !== -1) list[index] = { ...data, id: isEditing };
      } else {
        list.unshift({ ...data, id: Math.random().toString(36).substr(2, 9) });
      }
      return { ...prev, [category]: list };
    });
    setIsEditing(null);
  };

  const deleteDbEntry = (category: keyof HealthDatabase, id: string) => {
    setDb(prev => ({ ...prev, [category]: prev[category].filter((item: any) => item.id !== id) }));
  };

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
    setPendingLead(null);
    setInternalResults([]);
    setIsSearchingInternal(false);
    setIsSearchingWeb(false);
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
                  setPendingLead({ name: args.name, phone: args.phone, email: args.email });
                  toolResponse = "Pending user confirmation on screen. The user is currently viewing the confirmation modal.";
                } else if (fc.name === 'searchInternalDatabase') {
                  setIsSearchingInternal(true);
                  const args = fc.args as any;
                  const category = args.category as keyof HealthDatabase;
                  const query = args.query.toLowerCase();
                  
                  // Simulate brief async delay for visual feedback
                  await new Promise(r => setTimeout(r, 800));
                  
                  const results = (db[category] || []).filter((item: any) => 
                    Object.values(item).some(val => String(val).toLowerCase().includes(query))
                  );
                  setInternalResults(results);
                  setIsSearchingInternal(false);
                  toolResponse = results.length > 0 ? results : "No matches found in our internal database.";
                } else if (fc.name === 'searchWebHealthcare') {
                  setIsSearchingWeb(true);
                  const args = fc.args as any;
                  
                  // Simulate async web search delay
                  await new Promise(r => setTimeout(r, 1500));
                  
                  const mockResults = [
                    {title: `Web Insight for ${args.query}`, snippet: "Extracted information regarding health services, prices and preparations from public web sources."}
                  ];
                  setWebResults(mockResults);
                  setIsSearchingWeb(false);
                  toolResponse = mockResults;
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
                if (currentInputAcc.current.trim()) next.push({ role: 'user', text: currentInputAcc.current, timestamp: Date.now() });
                if (currentOutputAcc.current.trim()) next.push({ role: 'nira', text: currentOutputAcc.current, timestamp: Date.now() });
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
            setError(e.message || "Connection error.");
            handleStopCall();
          },
          onclose: () => handleStopCall(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: [SAVE_PATIENT_TOOL, WEB_SEARCH_TOOL, SEARCH_INTERNAL_TOOL] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error("Connection error:", err);
      setError(err.message || 'Error connecting to Nira');
      setStatus(CallStatus.ERROR);
    }
  };

  const renderConfirmationModal = () => {
    if (!pendingLead) return null;
    return (
      <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300">
        <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl p-8 border border-slate-100 animate-in zoom-in-95">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center shadow-inner">
              {ICON_HEART}
            </div>
            <div>
              <h3 className="text-xl font-black text-slate-800 tracking-tight">বুকিং নিশ্চিত করুন</h3>
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">Confirm Appointment</p>
            </div>
          </div>
          
          <div className="space-y-4 mb-8">
            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
              <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider">নাম (Name)</span>
              <p className="text-sm font-black text-slate-700 mt-1">{pendingLead.name}</p>
            </div>
            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
              <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider">ফোন (Phone)</span>
              <p className="text-sm font-black text-slate-700 mt-1">{pendingLead.phone}</p>
            </div>
            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
              <span className="text-[9px] font-black uppercase text-slate-400 tracking-wider">ইমেইল (Email)</span>
              <p className="text-sm font-black text-slate-700 mt-1">{pendingLead.email}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={() => setPendingLead(null)}
              className="py-5 rounded-2xl border border-slate-200 text-xs font-black uppercase tracking-widest text-slate-500 hover:bg-slate-50 transition-all active:scale-95"
            >
              বাতিল
            </button>
            <button 
              onClick={() => {
                saveLead(pendingLead.name, pendingLead.phone, pendingLead.email);
                setPendingLead(null);
              }}
              className="py-5 rounded-2xl bg-emerald-600 text-white text-xs font-black uppercase tracking-widest shadow-xl shadow-emerald-100 hover:bg-emerald-700 transition-all active:scale-95"
            >
              নিশ্চিত করুন
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderDbTabContent = () => {
    const categories: {key: keyof HealthDatabase, label: string}[] = [
      {key: 'doctors', label: 'ডাক্তার'},
      {key: 'diagnostics', label: 'ডায়াগনস্টিক'},
      {key: 'hospitals', label: 'হাসপাতাল'},
      {key: 'medicines', label: 'ঔষধ'},
      {key: 'firstAid', label: 'ফার্স্ট এইড'}
    ];

    const currentItem = isEditing ? (db[activeDbTab] as any[]).find(i => i.id === isEditing) : null;

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      const formData = new FormData(e.currentTarget as HTMLFormElement);
      const data = Object.fromEntries(formData.entries());
      upsertDbEntry(activeDbTab, data);
      (e.currentTarget as HTMLFormElement).reset();
    };

    return (
      <div className="bg-white p-8 md:p-10 rounded-[2.5rem] border border-slate-100 shadow-sm col-span-1 lg:col-span-3">
        <div className="flex items-center justify-between mb-10 overflow-x-auto pb-4 gap-3 no-scrollbar">
          {categories.map(cat => (
            <button 
              key={cat.key}
              onClick={() => { setActiveDbTab(cat.key); setIsEditing(null); }}
              className={`px-8 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all whitespace-nowrap shadow-sm border ${activeDbTab === cat.key ? 'bg-blue-600 text-white border-blue-600 shadow-blue-100' : 'bg-white text-slate-400 border-slate-100 hover:bg-slate-50'}`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-12">
          {/* Editor Form */}
          <div className="space-y-8">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
                {ICON_PLUS}
              </div>
              <h4 className="text-base font-black uppercase tracking-widest text-slate-800">
                {isEditing ? 'এন্ট্রি এডিট করুন' : 'নতুন তথ্য যোগ করুন'}
              </h4>
            </div>
            <form onSubmit={handleSubmit} className="space-y-5">
              {activeDbTab === 'doctors' && (
                <>
                  <input name="name" defaultValue={currentItem?.name} placeholder="ডাক্তারের নাম" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="specialty" defaultValue={currentItem?.specialty} placeholder="বিশেষজ্ঞ (Specialty)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="hospital" defaultValue={currentItem?.hospital} placeholder="হাসপাতালের নাম" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="contact" defaultValue={currentItem?.contact} placeholder="যোগাযোগ নম্বর" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                </>
              )}
              {activeDbTab === 'diagnostics' && (
                <>
                  <input name="name" defaultValue={currentItem?.name} placeholder="সেন্টারের নাম" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="tests" defaultValue={currentItem?.tests} placeholder="টেস্টসমূহ (MRI, Blood Test)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="location" defaultValue={currentItem?.location} placeholder="অবস্থান (Location)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="contact" defaultValue={currentItem?.contact} placeholder="যোগাযোগ নম্বর" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                </>
              )}
              {activeDbTab === 'hospitals' && (
                <>
                  <input name="name" defaultValue={currentItem?.name} placeholder="হাসপাতালের নাম" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="services" defaultValue={currentItem?.services} placeholder="সেবা (Services)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="address" defaultValue={currentItem?.address} placeholder="ঠিকানা" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="emergency" defaultValue={currentItem?.emergency} placeholder="জরুরি যোগাযোগ নম্বর" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                </>
              )}
              {activeDbTab === 'medicines' && (
                <>
                  <input name="name" defaultValue={currentItem?.name} placeholder="ঔষধের নাম" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <input name="type" defaultValue={currentItem?.type} placeholder="ঔষধের ধরন (Tablet, Syrup)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <textarea name="indications" defaultValue={currentItem?.indications} placeholder="ব্যবহার বিধি / কেন সেবন করবেন (Indications)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold min-h-[120px] outline-none focus:ring-4 focus:ring-blue-500/10 transition-all resize-none" required />
                </>
              )}
              {activeDbTab === 'firstAid' && (
                <>
                  <input name="condition" defaultValue={currentItem?.condition} placeholder="সমস্যা (Condition)" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-500/10 transition-all" required />
                  <textarea name="instructions" defaultValue={currentItem?.instructions} placeholder="ফার্স্ট এইড নির্দেশনা" className="w-full p-5 bg-slate-50 rounded-2xl border border-slate-100 text-xs font-bold min-h-[150px] outline-none focus:ring-4 focus:ring-blue-500/10 transition-all resize-none" required />
                </>
              )}
              <div className="flex gap-4 pt-4">
                {isEditing && (
                  <button type="button" onClick={() => setIsEditing(null)} className="flex-1 py-5 bg-slate-100 text-slate-500 rounded-3xl font-black text-xs uppercase tracking-widest border border-slate-200 hover:bg-slate-200 transition-all active:scale-95">বাতিল</button>
                )}
                <button type="submit" className="flex-[2] py-5 bg-blue-600 text-white rounded-3xl font-black text-xs uppercase tracking-widest shadow-xl shadow-blue-100 hover:bg-blue-700 transition-all active:scale-95">
                  {isEditing ? 'তথ্য আপডেট করুন' : 'তথ্য সেভ করুন'}
                </button>
              </div>
            </form>
          </div>

          {/* List View */}
          <div className="space-y-6">
            <div className="flex items-center justify-between sticky top-0 bg-white py-2 z-10 border-b border-slate-50 mb-4">
              <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">সংরক্ষিত তথ্য তালিকা</h4>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{db[activeDbTab].length} এন্ট্রি</span>
            </div>
            <div className="space-y-4 max-h-[600px] overflow-y-auto pr-3 custom-scrollbar">
              {db[activeDbTab].length === 0 ? (
                <div className="py-24 text-center text-slate-300 italic text-xs flex flex-col items-center gap-6">
                  <div className="scale-[2.5] opacity-20">{ICON_DATABASE}</div>
                  এই ক্যাটাগরিতে কোনো তথ্য পাওয়া যায়নি
                </div>
              ) : db[activeDbTab].map((item: any) => (
                <div key={item.id} className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 relative group hover:bg-white hover:shadow-xl hover:shadow-blue-500/5 transition-all">
                  <div className="absolute top-5 right-5 flex gap-3 opacity-0 group-hover:opacity-100 transition-all">
                    <button 
                      onClick={() => { setIsEditing(item.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} 
                      className="p-3 text-blue-500 hover:text-white hover:bg-blue-500 bg-white rounded-xl border border-slate-100 shadow-sm transition-all"
                      title="এডিট"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </button>
                    <button 
                      onClick={() => deleteDbEntry(activeDbTab, item.id)} 
                      className="p-3 text-red-500 hover:text-white hover:bg-red-500 bg-white rounded-xl border border-slate-100 shadow-sm transition-all"
                      title="ডিলিট"
                    >
                      {ICON_TRASH}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {Object.entries(item).map(([k, v]) => k !== 'id' && (
                      <div key={k} className="flex gap-4 border-b border-slate-200/50 pb-2 last:border-0">
                        <span className="text-[10px] font-black uppercase text-slate-400 w-28 pt-1 flex-shrink-0">{k}:</span>
                        <span className="text-xs font-bold text-slate-800 leading-relaxed">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderAdmin = () => (
    <main className="flex-1 max-w-7xl mx-auto w-full p-6 md:p-12 animate-in fade-in duration-500">
      {!isAdminAuthenticated ? (
        <div className="max-w-md mx-auto mt-20 bg-white p-12 rounded-[3rem] shadow-2xl border border-slate-100">
          <h2 className="text-3xl font-black text-slate-800 text-center mb-10">অ্যাডমিন লগইন</h2>
          <form onSubmit={handleAdminLogin} className="space-y-8">
            <div className="space-y-3">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-4">পাসওয়ার্ড</label>
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="admin123" className="w-full px-6 py-5 bg-slate-50 border border-slate-100 rounded-3xl text-sm font-bold outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all" required />
            </div>
            {loginError && <p className="text-red-500 text-xs font-black text-center animate-shake">{loginError}</p>}
            <button className="w-full py-5 bg-slate-800 text-white rounded-[2rem] font-black uppercase tracking-widest text-xs shadow-xl hover:bg-slate-700 transition-all active:scale-95">লগইন করুন</button>
          </form>
        </div>
      ) : (
        <div className="space-y-12">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-8">
            <div>
              <h2 className="text-4xl font-black text-slate-800 tracking-tight">অ্যাডমিন কন্ট্রোল সেন্টার</h2>
              <p className="text-[10px] md:text-xs text-slate-400 font-black uppercase tracking-[0.3em] mt-3 opacity-80">DATABASE • LEADS • SYSTEM CONFIG</p>
            </div>
            <button onClick={handleAdminLogout} className="px-10 py-4 bg-red-50 text-red-600 rounded-[2rem] text-xs font-black uppercase tracking-widest border border-red-100 hover:bg-red-100 transition-all active:scale-95">লগআউট</button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col min-h-[400px]">
               <div className="flex items-center gap-4 mb-10">
                 <div className="p-4 bg-emerald-50 text-emerald-600 rounded-2xl shadow-inner">{ICON_SETTINGS}</div>
                 <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">API কানেকশন</h4>
               </div>
               <div className="space-y-6 flex-1">
                 <div className={`p-6 rounded-[2rem] border ${isKeyAvailable ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                    <p className="text-[10px] font-black uppercase tracking-widest mb-2 opacity-60">নেটওয়ার্ক স্ট্যাটাস</p>
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${isKeyAvailable ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                      <p className="text-sm font-black">{isKeyAvailable ? 'সিস্টেম কানেক্টেড' : 'API কি প্রয়োজন'}</p>
                    </div>
                 </div>
                 <p className="text-xs text-slate-400 font-bold leading-relaxed px-2">Gemini Live API সচল রাখার জন্য অবশ্যই একটি ভ্যালিড কি নির্বাচন করুন।</p>
               </div>
               <button onClick={handleKeySelection} className="mt-8 w-full py-5 bg-emerald-600 text-white rounded-[2rem] font-black text-xs uppercase tracking-widest shadow-xl shadow-emerald-100 hover:bg-emerald-700 transition-all active:scale-95">সিস্টেম কি আপডেট করুন</button>
            </div>

            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col h-[500px]">
               <div className="flex items-center gap-4 mb-10">
                 <div className="p-4 bg-blue-50 text-blue-600 rounded-2xl shadow-inner">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                 </div>
                 <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">সংগৃহীত লিড ({patients.length})</h4>
               </div>
               <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                 <table className="w-full text-left">
                   <tbody className="divide-y divide-slate-50">
                     {patients.length === 0 ? (
                       <tr><td className="py-20 text-center text-slate-300 italic text-xs">কোনো লিড পাওয়া যায়নি</td></tr>
                     ) : patients.map(p => (
                       <tr key={p.id} className="group hover:bg-slate-50 transition-all">
                         <td className="py-6">
                           <p className="text-sm font-black text-slate-800">{p.name}</p>
                           <p className="text-[11px] text-slate-400 font-bold mt-0.5">{p.phone}</p>
                           <div className="mt-3">
                             <select 
                               value={p.status} 
                               onChange={(e) => updateLeadStatus(p.id, e.target.value as any)} 
                               className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-[10px] font-black shadow-sm outline-none focus:ring-4 focus:ring-blue-500/10"
                             >
                               <option value="new">NEW LEAD</option>
                               <option value="contacted">CONTACTED</option>
                               <option value="booked">BOOKED</option>
                             </select>
                           </div>
                         </td>
                         <td className="py-6 text-right align-top">
                           <button onClick={() => deleteLead(p.id)} className="text-red-300 hover:text-red-500 p-3 opacity-0 group-hover:opacity-100 transition-all" title="লিড ডিলিট করুন">{ICON_TRASH}</button>
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
            </div>

            <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm flex flex-col h-[500px]">
               <div className="flex items-center gap-4 mb-10">
                 <div className="p-4 bg-slate-50 text-slate-600 rounded-2xl shadow-inner">{ICON_CLOCK}</div>
                 <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">কল হিস্ট্রি সামারি</h4>
               </div>
               <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-5">
                 {callHistory.length === 0 ? (
                    <div className="py-20 text-center text-slate-300 italic text-xs">কল রেকর্ড পাওয়া যায়নি</div>
                 ) : callHistory.map(h => (
                   <div key={h.id} className="p-5 bg-slate-50 rounded-[2rem] border border-slate-100 relative group hover:bg-white transition-all">
                      <button onClick={() => deleteHistory(h.id)} className="absolute top-4 right-4 text-red-300 opacity-0 group-hover:opacity-100 transition-all p-2">{ICON_TRASH}</button>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2">{new Date(h.timestamp).toLocaleString('bn-BD')}</p>
                      <div className="flex items-center gap-2">
                        {h.summary === "সারাংশ তৈরি হচ্ছে..." && <LoadingSpinner size="w-3 h-3" color="text-slate-400" />}
                        <p className="text-[11px] font-bold text-slate-700 leading-relaxed">{h.summary}</p>
                      </div>
                   </div>
                 ))}
               </div>
            </div>

            {/* Health Database Manager */}
            <div className="col-span-1 lg:col-span-3 pt-6">
              <div className="flex items-center gap-4 mb-8">
                <div className="p-4 bg-blue-50 text-blue-600 rounded-2xl shadow-inner">{ICON_DATABASE}</div>
                <h4 className="text-sm font-black uppercase tracking-widest text-slate-800">রিসোর্স ডাটাবেস (Healthcare Network)</h4>
              </div>
              {renderDbTabContent()}
            </div>
          </div>
        </div>
      )}
    </main>
  );

  const renderAssistant = () => (
    <main className="flex-1 max-w-[1600px] mx-auto w-full p-4 md:p-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 animate-in fade-in duration-500 relative">
      <section className="bg-white rounded-[3rem] shadow-sm border border-slate-100 p-10 flex flex-col items-center justify-center text-center group relative min-h-[450px] transition-all hover:shadow-2xl hover:shadow-emerald-500/5">
        {lastSavedPatient && (
          <div className="absolute top-8 left-1/2 -translate-x-1/2 w-[90%] bg-emerald-600 text-white py-4 px-6 rounded-3xl text-[11px] font-black uppercase tracking-widest animate-in slide-in-from-top-6 shadow-2xl z-20 flex items-center justify-center gap-3">
            <div className="w-2.5 h-2.5 bg-white rounded-full animate-ping"></div>
            সফল বুকিং: {lastSavedPatient}
          </div>
        )}
        
        <div className={`w-48 h-48 md:w-64 md:h-64 rounded-full flex items-center justify-center mb-12 transition-all duration-1000 ${status === CallStatus.ACTIVE ? 'bg-emerald-50 scale-110 shadow-[inset_0_2px_10px_rgba(16,185,129,0.1)]' : status === CallStatus.CONNECTING ? 'bg-emerald-50' : 'bg-slate-50'}`}>
          <div className={`scale-[2.5] md:scale-[3.5] transition-all duration-700 ${status === CallStatus.ACTIVE ? 'text-emerald-600' : status === CallStatus.CONNECTING ? 'text-emerald-500' : 'text-slate-300 group-hover:scale-[3.8] group-hover:text-slate-400'}`}>
            {status === CallStatus.ACTIVE ? (
              <div className="flex gap-1.5 items-end">
                <div className="w-2.5 h-10 bg-emerald-500 rounded-full animate-bounce [animation-duration:1.1s]"></div>
                <div className="w-2.5 h-20 bg-emerald-500 rounded-full animate-bounce [animation-duration:0.9s]"></div>
                <div className="w-2.5 h-14 bg-emerald-500 rounded-full animate-bounce [animation-duration:1.3s]"></div>
                <div className="w-2.5 h-18 bg-emerald-500 rounded-full animate-bounce [animation-duration:1.0s]"></div>
              </div>
            ) : status === CallStatus.CONNECTING ? (
              <LoadingSpinner size="w-16 h-16" color="text-emerald-600" />
            ) : ICON_MIC}
          </div>
        </div>
        
        <div className="space-y-3 mb-12">
          <h2 className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight">
            {status === CallStatus.IDLE && "নিরার সাথে কথা বলুন"}
            {status === CallStatus.CONNECTING && "সংযোগ হচ্ছে..."}
            {status === CallStatus.ACTIVE && "নিরা শুনছে..."}
            {status === CallStatus.ERROR && "সংযোগ ত্রুটি"}
          </h2>
          <p className="text-slate-400 text-xs md:text-sm font-bold max-w-[280px] mx-auto leading-relaxed opacity-70">
            {status === CallStatus.ERROR ? error : status === CallStatus.CONNECTING ? "Gemini Live API এর সাথে সংযুক্ত হওয়া হচ্ছে" : "আপনার মেডিকেল অ্যাপয়েন্টমেন্ট বা তথ্যের জন্য কল বাটন চাপুন।"}
          </p>
        </div>

        <button
          onClick={status === CallStatus.ACTIVE ? handleStopCall : handleStartCall}
          className={`w-full max-w-[300px] flex items-center justify-center gap-5 py-6 rounded-[2.5rem] font-black text-white transition-all shadow-2xl active:scale-95 transform hover:-translate-y-1.5 ${status === CallStatus.ACTIVE ? 'bg-red-500 shadow-red-200 hover:bg-red-600' : 'bg-emerald-600 shadow-emerald-200 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed'}`}
          disabled={status === CallStatus.CONNECTING}
        >
          <div className="scale-125">{status === CallStatus.ACTIVE ? ICON_PHONE_OFF : ICON_MIC}</div>
          <span className="tracking-[0.2em] uppercase text-xs md:text-sm">{status === CallStatus.ACTIVE ? 'কল শেষ করুন' : status === CallStatus.CONNECTING ? 'অপেক্ষা করুন' : 'কল শুরু করুন'}</span>
        </button>
      </section>

      <section className="bg-white rounded-[3rem] shadow-sm border border-slate-100 flex flex-col h-[500px] md:h-auto overflow-hidden transition-all hover:shadow-2xl hover:shadow-emerald-500/5">
        <div className="p-8 border-b border-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
            <h3 className="font-black text-slate-800 text-xs md:text-sm uppercase tracking-[0.2em]">লাইভ ট্রান্সক্রিপ্ট</h3>
          </div>
          {status === CallStatus.ACTIVE && <span className="text-[10px] font-black text-emerald-600 animate-pulse tracking-widest uppercase">রেকর্ডিং</span>}
        </div>
        <div className="flex-1 overflow-y-auto p-8 space-y-8 bg-slate-50/20 custom-scrollbar">
          {transcriptions.length === 0 && !activeUserText && !activeNiraText ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-30 text-center">
               <div className="scale-[4] mb-12"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
               <p className="text-[11px] font-black uppercase tracking-[0.3em] px-10 leading-relaxed">কথোপকথন এখানে রিয়েল-টাইমে দেখা যাবে</p>
            </div>
          ) : (
            <>
              {transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-3`}>
                  <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2 px-3">{t.role === 'user' ? 'আপনি' : 'নিরা'}</span>
                  <div className={`max-w-[85%] rounded-[1.5rem] p-5 text-sm font-bold shadow-sm border ${t.role === 'user' ? 'bg-emerald-600 text-white border-emerald-700 rounded-tr-none' : 'bg-white text-slate-700 border-slate-100 rounded-tl-none'}`}>
                    {t.text}
                  </div>
                </div>
              ))}
              {activeUserText && <div className="flex flex-col items-end opacity-60"><div className="max-w-[85%] rounded-[1.5rem] p-5 text-sm font-bold bg-emerald-50 text-emerald-800 border border-emerald-100 rounded-tr-none italic animate-pulse">{activeUserText}</div></div>}
              {activeNiraText && <div className="flex flex-col items-start animate-in fade-in"><span className="text-[9px] font-black uppercase tracking-widest text-emerald-600 mb-2 px-3">নিরা বলছে...</span><div className="max-w-[85%] rounded-[1.5rem] p-5 text-sm font-bold bg-white text-slate-500 border border-slate-100 rounded-tl-none shadow-sm flex items-center gap-3">{activeNiraText}<div className="w-1.5 h-5 bg-emerald-400 animate-pulse rounded-full"></div></div></div>}
            </>
          )}
          <div ref={lastTranscriptionRef} />
        </div>
      </section>

      <section className="bg-white rounded-[3rem] shadow-sm border border-slate-100 flex flex-col h-[350px] md:h-auto overflow-hidden transition-all hover:shadow-2xl hover:shadow-emerald-500/5">
        <div className="p-8 border-b border-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-3 h-3 rounded-full bg-emerald-400"></div>
            <h3 className="font-black text-slate-800 text-xs md:text-sm uppercase tracking-[0.2em]">রিসোর্স ও নেটওয়ার্ক</h3>
          </div>
          {isSearchingInternal && <LoadingSpinner size="w-4 h-4" color="text-emerald-500" />}
        </div>
        <div className="flex-1 p-6 overflow-y-auto custom-scrollbar bg-slate-50/10">
           {isSearchingInternal ? (
              <div className="h-full flex flex-col items-center justify-center space-y-4 animate-pulse">
                <LoadingSpinner size="w-10 h-10" color="text-emerald-500/30" />
                <p className="text-[10px] font-black text-emerald-600/50 uppercase tracking-widest">ডাটাবেস অনুসন্ধান করা হচ্ছে...</p>
              </div>
           ) : internalResults.length === 0 ? (
             <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-30 text-center">
               <div className="scale-[4] mb-16 text-emerald-500/20">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
               </div>
               <p className="text-[11px] font-black uppercase tracking-[0.3em] leading-relaxed px-8">আমাদের নেটওয়ার্কের ডাক্তার বা তথ্য এখানে দেখা যাবে</p>
             </div>
           ) : (
             <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
               {internalResults.map((item, idx) => (
                 <div key={idx} className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm">
                    {Object.entries(item).map(([k, v]) => k !== 'id' && (
                      <div key={k} className="flex gap-2 border-b border-slate-50 last:border-0 pb-1.5 mb-1.5 last:pb-0 last:mb-0">
                        <span className="text-[9px] font-black uppercase text-slate-400 w-20 flex-shrink-0 pt-0.5">{k}:</span>
                        <span className="text-xs font-bold text-slate-700">{String(v)}</span>
                      </div>
                    ))}
                 </div>
               ))}
               <button onClick={() => setInternalResults([])} className="w-full py-2 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-red-500 transition-all">ফলাফল মুছুন</button>
             </div>
           )}
        </div>
      </section>

      <section className="bg-white rounded-[3rem] shadow-sm border border-slate-100 flex flex-col h-[450px] md:h-auto overflow-hidden transition-all hover:shadow-2xl hover:shadow-emerald-500/5">
        <div className="p-8 border-b border-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-3 h-3 rounded-full bg-blue-500"></div>
            <h3 className="font-black text-slate-800 text-xs md:text-sm uppercase tracking-[0.2em]">ইন্টারনেট রিসার্চ</h3>
          </div>
          {isSearchingWeb && <LoadingSpinner size="w-4 h-4" color="text-blue-500" />}
        </div>
        <div className="flex-1 p-8 overflow-y-auto custom-scrollbar bg-slate-50/10">
          {isSearchingWeb ? (
             <div className="h-full flex flex-col items-center justify-center space-y-4 animate-pulse">
               <LoadingSpinner size="w-10 h-10" color="text-blue-500/30" />
               <p className="text-[10px] font-black text-blue-600/50 uppercase tracking-widest">ওয়েব সার্চ করা হচ্ছে...</p>
             </div>
          ) : webResults.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-30 text-center">
               <div className="scale-[4] mb-16 text-blue-500/20">
                 <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
               </div>
               <p className="text-[11px] font-black uppercase tracking-[0.3em] leading-relaxed px-8">ওয়েব থেকে প্রাপ্ত খরচ বা প্রস্তুতির তথ্য এখানে দেখা যাবে</p>
            </div>
          ) : (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
              {webResults.map((res, idx) => (
                <div key={idx} className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:border-blue-200 transition-all">
                  <h4 className="text-blue-600 font-black text-sm mb-3 tracking-tight">{res.title}</h4>
                  <p className="text-slate-600 text-xs font-bold leading-relaxed">{res.snippet}</p>
                </div>
              ))}
              <button onClick={() => setWebResults([])} className="w-full py-2 text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-red-500 transition-all">ফলাফল মুছুন</button>
            </div>
          )}
        </div>
      </section>
      
      {renderConfirmationModal()}
    </main>
  );

  const renderHistory = () => (
    <main className="flex-1 max-w-5xl mx-auto w-full p-6 md:p-12 animate-in fade-in duration-500">
      <div className="flex items-center justify-between mb-12">
        <div>
          <h2 className="text-4xl font-black text-slate-800 tracking-tight">কল হিস্ট্রি</h2>
          <p className="text-[10px] md:text-xs text-slate-400 font-black uppercase tracking-[0.3em] mt-3 opacity-80">YOUR CONVERSATIONS • SUMMARIES</p>
        </div>
        <button 
          onClick={() => {
            if (selectedHistory) setSelectedHistory(null);
            else setView('assistant');
          }} 
          className="px-10 py-4 bg-emerald-50 text-emerald-600 rounded-[2rem] text-xs font-black uppercase tracking-widest border border-emerald-100 hover:bg-emerald-100 transition-all active:scale-95"
        >
          ফিরে যান
        </button>
      </div>

      {!selectedHistory ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {callHistory.length === 0 ? (
            <div className="col-span-full py-32 text-center text-slate-300 font-black uppercase tracking-[0.4em] opacity-30">কোনো কল রেকর্ড নেই</div>
          ) : callHistory.map(h => (
            <div key={h.id} className="bg-white p-10 rounded-[3rem] border border-slate-100 shadow-sm hover:shadow-2xl hover:shadow-emerald-500/5 transition-all group animate-in slide-in-from-bottom-6">
              <div className="flex items-center justify-between mb-8">
                <div className="px-4 py-1.5 bg-emerald-50 text-emerald-600 text-[10px] font-black rounded-xl uppercase tracking-widest border border-emerald-100">
                  কল শেষ
                </div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{new Date(h.timestamp).toLocaleString('bn-BD')}</p>
              </div>
              <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-400 mb-3 opacity-60">সারাংশ (Summary)</h4>
              <div className="flex items-center gap-3 mb-10 min-h-[4rem]">
                {h.summary === "সারাংশ তৈরি হচ্ছে..." ? (
                  <div className="flex items-center gap-2">
                    <LoadingSpinner size="w-4 h-4" color="text-slate-400" />
                    <span className="text-xs text-slate-400 font-bold italic">সারাংশ তৈরি করা হচ্ছে...</span>
                  </div>
                ) : (
                  <p className="text-base font-bold text-slate-700 leading-relaxed">{h.summary}</p>
                )}
              </div>
              <div className="pt-8 border-t border-slate-50 flex items-center justify-between">
                 <button 
                    onClick={() => setSelectedHistory(h)}
                    className="text-[10px] font-black uppercase tracking-widest text-emerald-600 hover:opacity-70 flex items-center gap-3 group/btn"
                 >
                    বিস্তারিত দেখুন <span className="group-hover/btn:translate-x-1.5 transition-transform duration-300">→</span>
                 </button>
                 <button onClick={() => deleteHistory(h.id)} className="p-3 text-slate-300 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100 bg-slate-50 rounded-xl" title="কল মুছুন">
                    {ICON_TRASH}
                 </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-[3rem] shadow-xl border border-slate-100 overflow-hidden animate-in slide-in-from-right-10 duration-500">
           <div className="p-10 md:p-14 border-b border-slate-100 bg-slate-50/30">
              <div className="flex items-center justify-between mb-6">
                 <h3 className="text-2xl font-black text-slate-800">কলের বিস্তারিত</h3>
                 <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{new Date(selectedHistory.timestamp).toLocaleString('bn-BD')}</p>
              </div>
              <p className="text-sm font-bold text-slate-600 leading-relaxed max-w-3xl italic">
                “{selectedHistory.summary}”
              </p>
           </div>
           <div className="p-10 md:p-14 space-y-10 max-h-[600px] overflow-y-auto custom-scrollbar">
              {selectedHistory.transcript.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in`}>
                   <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2 px-3">
                     {t.role === 'user' ? 'আপনি' : 'নিরা'}
                   </span>
                   <div className={`max-w-[85%] rounded-[1.5rem] p-5 text-sm font-bold shadow-sm border ${t.role === 'user' ? 'bg-emerald-600 text-white border-emerald-700 rounded-tr-none' : 'bg-white text-slate-700 border-slate-100 rounded-tl-none'}`}>
                     {t.text}
                   </div>
                </div>
              ))}
           </div>
           <div className="p-10 bg-slate-50 flex justify-center">
              <button 
                onClick={() => setSelectedHistory(null)}
                className="px-12 py-4 bg-slate-800 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-slate-700 transition-all active:scale-95"
              >
                হিস্ট্রি তালিকায় ফিরে যান
              </button>
           </div>
        </div>
      )}
    </main>
  );

  const renderGuide = () => (
    <main className="flex-1 max-w-5xl mx-auto w-full p-6 md:p-12 animate-in fade-in zoom-in-95 duration-500">
      <div className="bg-white rounded-[4rem] border border-slate-100 shadow-2xl overflow-hidden">
        {/* Guide Header */}
        <div className="bg-gradient-to-br from-emerald-600 to-emerald-800 p-12 md:p-20 text-white text-center">
          <div className="w-20 h-20 bg-white/10 backdrop-blur-md rounded-3xl flex items-center justify-center mx-auto mb-10 shadow-inner">
             <div className="scale-[2]">{ICON_INFO}</div>
          </div>
          <h2 className="text-4xl md:text-5xl font-black mb-6 tracking-tight">নির্দেশিকা ও সহায়িকা (Guide)</h2>
          <p className="text-emerald-100/80 font-bold text-sm md:text-lg max-w-2xl mx-auto leading-relaxed uppercase tracking-widest">নিরার সকল ফিচারের সঠিক ব্যবহারের নির্দেশনাবলী</p>
        </div>

        {/* Guide Content */}
        <div className="p-10 md:p-20 space-y-20">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
            {/* Capability 1 */}
            <section className="space-y-6 group">
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                   {ICON_HEART}
                </div>
                <h3 className="text-xl font-black text-slate-800">অ্যাপয়েন্টমেন্ট বুকিং</h3>
              </div>
              <p className="text-slate-500 text-sm font-bold leading-relaxed ml-1 pt-2">
                নিরা আপনার জন্য ডাক্তার বা ডায়াগনস্টিক অ্যাপয়েন্টমেন্ট বুক করতে পারে। কথা বলার সময় তাকে শুধু বলুন আপনি কার সাথে অ্যাপয়েন্টমেন্ট করতে চান। নিরা আপনার নাম, ফোন নম্বর এবং ইমেইল ঠিকানা সংগ্রহ করার পর স্ক্রিনে একটি কনফার্মেশন পপ-আপ দেখাবে।
              </p>
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 text-[11px] font-black text-emerald-700 uppercase tracking-widest">
                টিপস: "আমি একজন হার্ট স্পেশালিস্টের সাথে অ্যাপয়েন্টমেন্ট করতে চাই" - এভাবে শুরু করুন।
              </div>
            </section>

            {/* Capability 2 */}
            <section className="space-y-6 group">
              <div className="flex items-center gap-5">
                <div className="w-14 h-14 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                   {ICON_DATABASE}
                </div>
                <h3 className="text-xl font-black text-slate-800">রিসোর্স ও ডাক্তার খোঁজা</h3>
              </div>
              <p className="text-slate-500 text-sm font-bold leading-relaxed ml-1 pt-2">
                আমাদের নেটওয়ার্কে থাকা সেরা ডাক্তার, হাসপাতাল এবং ঔষধের তথ্য নিরা নিমেষেই খুঁজে দেবে। যদি আমাদের ডাটাবেসে তথ্য না থাকে, তবে সে ইন্টারনেট (Web Search) ব্যবহার করে আপনাকে টেস্টের সম্ভাব্য খরচ এবং প্রস্তুতির নিয়ম জানাবে।
              </p>
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 text-[11px] font-black text-blue-700 uppercase tracking-widest">
                টিপস: "ঢাকার আশেপাশে কোনো ভালো ব্লাড ব্যাংক আছে?" - জিজ্ঞাসা করুন।
              </div>
            </section>
          </div>

          <hr className="border-slate-100" />

          {/* FAQ Section */}
          <section className="space-y-12">
            <h3 className="text-3xl font-black text-slate-800 text-center tracking-tight">সচরাচর জিজ্ঞাসিত প্রশ্নাবলী (FAQ)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {[
                {
                  q: "নিরা কি বাংলায় কথা বলতে পারে?",
                  a: "হ্যাঁ, নিরা সম্পূর্ণ বাংলায় এবং অত্যন্ত শুদ্ধভাবে আপনার সাথে কথা বলতে সক্ষম।"
                },
                {
                  q: "বুকিং করার জন্য কি কি তথ্য প্রয়োজন?",
                  a: "বুকিং নিশ্চিত করার জন্য ব্যবহারকারীর নাম, একটি সচল ফোন নম্বর এবং একটি ইমেইল ঠিকানা প্রয়োজন।"
                },
                {
                  q: "কল হিস্ট্রি কি চিরস্থায়ী?",
                  a: "না, আপনার কথোপকথন ব্রাউজারের লোকাল স্টোরেজে জমা থাকে। ক্যাশে ডিলিট করলে বা 'কল মুছুন' বাটন চাপলে তা মুছে যাবে।"
                },
                {
                  q: "নিরা কি ঔষধের পরামর্শ দিতে পারে?",
                  a: "নিরা কোনো প্রেসক্রিপশন প্রদান করে না। তবে সে ঔষধের সাধারণ ব্যবহার এবং ডায়াগনস্টিক প্রস্তুতির তথ্য দিতে পারে।"
                }
              ].map((faq, idx) => (
                <div key={idx} className="p-8 bg-slate-50/50 rounded-[2.5rem] border border-slate-100 hover:bg-white hover:shadow-xl hover:shadow-emerald-500/5 transition-all">
                  <h4 className="text-sm font-black text-slate-800 mb-3 flex items-start gap-3">
                    <span className="text-emerald-600">প্রশ্ন:</span> {faq.q}
                  </h4>
                  <p className="text-xs font-bold text-slate-500 leading-relaxed pl-10">
                    {faq.a}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <button 
            onClick={() => setView('assistant')} 
            className="w-full py-6 bg-emerald-600 text-white rounded-3xl font-black uppercase tracking-[0.3em] shadow-2xl shadow-emerald-100 hover:bg-emerald-700 transition-all active:scale-95 text-sm"
          >
            কল শুরু করতে ফিরে যান
          </button>
        </div>
      </div>
    </main>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#fcfdfe] font-sans text-slate-900 overflow-x-hidden selection:bg-emerald-100">
      <header className="w-full bg-white/80 backdrop-blur-xl border-b border-slate-200 px-6 md:px-12 py-5 flex flex-col sm:flex-row items-center justify-between gap-6 sticky top-0 z-[60]">
        <div className="flex items-center gap-5 cursor-pointer group" onClick={() => setView('assistant')}>
          <div className="w-14 h-14 bg-emerald-600 rounded-[1.5rem] flex items-center justify-center shadow-xl shadow-emerald-100 group-hover:rotate-12 transition-all duration-500">
            <div className="scale-150 brightness-0 invert">{ICON_HEART}</div>
          </div>
          <div className="flex flex-col">
            <h1 className="text-2xl font-black text-slate-800 tracking-tighter leading-none">হেলথ সাপোর্ট সেন্টার</h1>
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest opacity-80 mt-1.5">ভার্চুয়াল সহকারী: নিরা</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setView('history'); setSelectedHistory(null); }} className={`px-6 py-3 rounded-2xl transition-all flex items-center gap-3 font-black text-[11px] uppercase tracking-widest ${view === 'history' ? 'bg-emerald-600 text-white shadow-lg' : 'text-slate-500 hover:bg-slate-50 border border-transparent hover:border-slate-100'}`} title="কল হিস্ট্রি">
            {ICON_CLOCK} <span className="hidden md:inline">হিস্ট্রি</span>
          </button>
          <button onClick={() => setView('guide')} className={`px-6 py-3 rounded-2xl transition-all flex items-center gap-3 font-black text-[11px] uppercase tracking-widest ${view === 'guide' ? 'bg-emerald-600 text-white shadow-lg' : 'text-slate-500 hover:bg-slate-50 border border-transparent hover:border-slate-100'}`} title="ইউজার গাইড">
            {ICON_INFO} <span className="hidden md:inline">গাইড</span>
          </button>
          <button onClick={() => setView(view === 'admin' ? 'assistant' : 'admin')} className={`px-6 py-3 rounded-2xl transition-all flex items-center gap-3 font-black text-[11px] uppercase tracking-widest ${view === 'admin' ? 'bg-slate-800 text-white shadow-lg' : 'text-slate-500 hover:bg-slate-50 border border-transparent hover:border-slate-100'}`} title="অ্যাডমিন">
            {ICON_SETTINGS} <span className="hidden md:inline">অ্যাডমিন</span>
          </button>
        </div>
      </header>

      {view === 'assistant' && renderAssistant()}
      {view === 'admin' && renderAdmin()}
      {view === 'history' && renderHistory()}
      {view === 'guide' && renderGuide()}
      
      <footer className="w-full bg-white border-t border-slate-100 py-10 text-center mt-auto px-8">
        <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.5em] opacity-40">
          © ২০২৬ হেলথ সাপোর্ট সেন্টার • নিরা ২.১৮.০-HISTORY-DETAILS • MADE WITH AI
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
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
