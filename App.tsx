
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { CallStatus, TranscriptionEntry } from './types.ts';
import { decode, decodeAudioData, createBlob } from './audioUtils.ts';
import { SYSTEM_PROMPT, SEARCH_TOOL, WEB_SEARCH_TOOL, ICON_MIC, ICON_PHONE_OFF, ICON_HEART, ICON_MAP_PIN, ICON_GLOBE } from './constants.tsx';

interface ResourceResult {
  title: string;
  uri: string;
}

const App: React.FC = () => {
  const [status, setStatus] = useState<CallStatus>(CallStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mapResults, setMapResults] = useState<ResourceResult[]>([]);
  const [webResults, setWebResults] = useState<ResourceResult[]>([]);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => console.warn('Geolocation denied or failed', err)
      );
    }
  }, []);

  const addTranscription = useCallback((role: 'user' | 'nira', text: string) => {
    if (!text.trim()) return;
    setTranscriptions(prev => [
      ...prev,
      { role, text, timestamp: Date.now() }
    ]);
  }, []);

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
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `Find nearby ${category} in Bangla. Give a short summary.`;
      
      const config: any = {
        tools: [{ googleMaps: {} }],
      };

      if (userCoords) {
        config.toolConfig = {
          retrievalConfig: {
            latLng: {
              latitude: userCoords.lat,
              longitude: userCoords.lng
            }
          }
        };
      }

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config
      });

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const results: ResourceResult[] = chunks
        .filter((c: any) => c.maps)
        .map((c: any) => ({
          title: c.maps.title,
          uri: c.maps.uri
        }));

      setMapResults(prev => [...results, ...prev].slice(0, 10));
      return { status: "success", found: results.length, text: response.text };
    } catch (err: any) {
      console.error("Maps search failed", err);
      if (err?.message?.includes("Requested entity was not found") && (window as any).aistudio) {
        await (window as any).aistudio.openSelectKey();
      }
      return { status: "error", message: "Failed to search Maps" };
    }
  };

  const performWebSearch = async (query: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `ইন্টারনেট থেকে ${query} সম্পর্কে সঠিক তথ্য (যেমন: টেস্টের দাম, প্রস্তুতির নিয়ম) দিন এবং সংশ্লিষ্ট লিঙ্কগুলো খুঁজে বের করুন। উত্তর অবশ্যই বাংলায় হতে হবে।`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const results: ResourceResult[] = chunks
        .filter((c: any) => c.web)
        .map((c: any) => ({
          title: c.web.title,
          uri: c.web.uri
        }));

      setWebResults(prev => [...results, ...prev].slice(0, 10));
      return { status: "success", found: results.length, text: response.text };
    } catch (err: any) {
      console.error("Web search failed", err);
      return { status: "error", message: "Failed to search Web" };
    }
  };

  const handleStartCall = async () => {
    try {
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
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(err => console.error("Error sending realtime audio", err));
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'searchNearbyHealthcare') {
                  const result = await performMapsSearch((fc.args as any).category);
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: result.status, info: result.text || "" },
                      }
                    });
                  });
                } else if (fc.name === 'searchWebHealthcare') {
                  const result = await performWebSearch((fc.args as any).query);
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: fc.id,
                        name: fc.name,
                        response: { result: result.status, info: result.text || "" },
                      }
                    });
                  });
                }
              }
            }

            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const uText = currentInputTranscriptionRef.current;
              const nText = currentOutputTranscriptionRef.current;
              if (uText) addTranscription('user', uText);
              if (nText) addTranscription('nira', nText);
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
                source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioSourcesRef.current.add(source);
              }
            }

            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Live API Error:', e);
            setError('সংযোগ বিচ্ছিন্ন হয়েছে। দয়া করে আবার চেষ্টা করুন।');
            handleStopCall();
          },
          onclose: () => handleStopCall(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: [SEARCH_TOOL, WEB_SEARCH_TOOL] }],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      if (err?.message?.includes("Requested entity was not found") && (window as any).aistudio) {
        await (window as any).aistudio.openSelectKey();
      }
      setError(err.message || 'ভয়েস সেশন শুরু করা যায়নি।');
      setStatus(CallStatus.ERROR);
    }
  };

  useEffect(() => {
    return () => handleStopCall();
  }, [handleStopCall]);

  const lastTranscriptionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lastTranscriptionRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptions]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 overflow-x-hidden">
      {/* Header - Fixed or Sticky for better access */}
      <header className="sticky top-0 z-10 w-full bg-white/80 backdrop-blur-md border-b border-slate-200 px-4 md:px-8 py-4 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-emerald-600 rounded-full flex items-center justify-center shadow-lg shadow-emerald-100 shrink-0">
              {ICON_HEART}
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 leading-tight">হেলথ সাপোর্ট</h1>
              <p className="text-xs md:text-sm text-slate-500 font-medium">ভার্চুয়াল সহকারী: নিরা</p>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold whitespace-nowrap">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
            অনলাইন
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-8 flex flex-col lg:grid lg:grid-cols-12 gap-8 items-start">
        
        {/* Call Panel - Primary Action */}
        <div className="w-full lg:col-span-4 xl:col-span-3 bg-white rounded-[2.5rem] shadow-xl p-8 flex flex-col items-center justify-center min-h-[360px] md:min-h-[400px] border border-slate-100 transition-all">
          <div className="relative mb-8">
            <div className={`w-32 h-32 md:w-40 md:h-40 rounded-full flex items-center justify-center transition-all duration-500 ${
              status === CallStatus.ACTIVE ? 'bg-emerald-100 animate-pulse' : 'bg-slate-100'
            }`}>
              <div className={`w-24 h-24 md:w-32 md:h-32 rounded-full flex items-center justify-center transition-all duration-300 ${
                status === CallStatus.ACTIVE ? 'bg-emerald-500 shadow-xl shadow-emerald-200 text-white' : 'bg-slate-200 text-slate-400'
              }`}>
                {status === CallStatus.ACTIVE ? (
                  <div className="flex gap-1.5 items-end">
                    <div className="w-2 h-8 bg-white animate-[bounce_1s_infinite]"></div>
                    <div className="w-2 h-14 bg-white animate-[bounce_1.2s_infinite]"></div>
                    <div className="w-2 h-10 bg-white animate-[bounce_0.8s_infinite]"></div>
                    <div className="w-2 h-6 bg-white animate-[bounce_1.1s_infinite]"></div>
                  </div>
                ) : (
                  <div className="scale-125 md:scale-150">{ICON_MIC}</div>
                )}
              </div>
            </div>
            {status === CallStatus.CONNECTING && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-36 h-36 md:w-44 md:h-44 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
          </div>

          <div className="text-center mb-8 px-2">
            <h2 className="text-xl md:text-2xl font-bold text-slate-800 mb-3">
              {status === CallStatus.IDLE && "আমি আপনাকে সাহায্য করতে প্রস্তুত"}
              {status === CallStatus.CONNECTING && "সংযোগ স্থাপন করা হচ্ছে..."}
              {status === CallStatus.ACTIVE && "নিরা শুনছে..."}
              {status === CallStatus.ERROR && "সংযোগ ত্রুটি"}
            </h2>
            <p className="text-slate-500 text-sm md:text-base leading-relaxed max-w-xs mx-auto">
              {status === CallStatus.IDLE && "নিরাপদ ভয়েস কনসালটেশন শুরু করতে নিচের বোতামটি ক্লিক করুন।"}
              {status === CallStatus.ACTIVE && "আপনি এখন কথা বলতে পারেন। ডাক্তার বা ডায়াগনস্টিক সেন্টার খুঁজুন।"}
              {status === CallStatus.ERROR && (error || "কিছু ভুল হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।")}
            </p>
          </div>

          <button
            onClick={status === CallStatus.ACTIVE ? handleStopCall : handleStartCall}
            className={`w-full group flex items-center justify-center gap-4 px-8 py-5 rounded-[2rem] font-bold text-lg shadow-lg transition-all active:scale-95 ${
              status === CallStatus.ACTIVE 
                ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-100' 
                : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-100'
            }`}
          >
            <div className={`${status === CallStatus.ACTIVE ? 'bg-red-400' : 'bg-emerald-500'} p-2.5 rounded-xl shrink-0`}>
              {status === CallStatus.ACTIVE ? ICON_PHONE_OFF : ICON_MIC}
            </div>
            <span>{status === CallStatus.ACTIVE ? 'কল শেষ করুন' : 'কল শুরু করুন'}</span>
          </button>
        </div>

        {/* Secondary Panels: Displays and Information */}
        <div className="w-full lg:col-span-8 xl:col-span-9 flex flex-col gap-6">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            
            {/* Live Transcript Panel */}
            <div className="bg-white rounded-[2rem] shadow-lg border border-slate-100 flex flex-col h-[400px] md:h-[450px]">
              <div className="p-5 border-b border-slate-100 flex items-center justify-between shrink-0">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  লাইভ ট্রান্সক্রিপ্ট
                </h3>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                {transcriptions.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-3 opacity-60">
                    <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    <p className="text-xs md:text-sm font-medium">কথোপকথন এখানে রেকর্ড করা হবে</p>
                  </div>
                ) : (
                  transcriptions.map((t, i) => (
                    <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'}`}>
                      <span className="text-[10px] text-slate-400 mb-1 px-1">{t.role === 'user' ? 'আপনি' : 'নিরা'}</span>
                      <div className={`max-w-[85%] rounded-[1.25rem] p-3.5 text-sm leading-relaxed ${
                        t.role === 'user' 
                          ? 'bg-emerald-600 text-white rounded-br-none' 
                          : 'bg-slate-100 text-slate-700 rounded-bl-none shadow-sm'
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
            <div className="bg-white rounded-[2rem] shadow-lg border border-slate-100 flex flex-col h-[400px] md:h-[450px]">
              <div className="p-5 border-b border-slate-100 shrink-0">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  {ICON_MAP_PIN} ম্যাপ লোকেশন
                </h3>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {mapResults.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center px-4 space-y-3 opacity-60">
                    <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    <p className="text-xs italic md:text-sm">কাছাকাছি হাসপাতাল বা ডাক্তারের তথ্য এখানে আসবে।</p>
                  </div>
                ) : (
                  mapResults.map((res, i) => (
                    <a 
                      key={i} 
                      href={res.uri} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="block p-4 rounded-2xl bg-slate-50 border border-slate-100 hover:border-emerald-200 hover:bg-emerald-50 transition-all group shadow-sm active:scale-[0.98]"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-sm font-bold text-slate-800 group-hover:text-emerald-700 transition-colors">{res.title}</span>
                        <div className="shrink-0 p-1.5 bg-white rounded-lg shadow-sm">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400 group-hover:text-emerald-500"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                        </div>
                      </div>
                    </a>
                  ))
                )}
              </div>
            </div>

            {/* Web Search Panel */}
            <div className="bg-white rounded-[2rem] shadow-lg border border-slate-100 flex flex-col h-[400px] md:h-[450px]">
              <div className="p-5 border-b border-slate-100 shrink-0">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  {ICON_GLOBE} ওয়েবসাইট ও বিস্তারিত
                </h3>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {webResults.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center px-4 space-y-3 opacity-60">
                    <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>
                    <p className="text-xs italic md:text-sm">টেস্টের খরচ বা প্রস্তুতির নিয়ম এখানে দেখা যাবে।</p>
                  </div>
                ) : (
                  webResults.map((res, i) => (
                    <a 
                      key={i} 
                      href={res.uri} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="block p-4 rounded-2xl bg-blue-50/50 border border-blue-100 hover:border-blue-300 hover:bg-blue-50 transition-all group shadow-sm active:scale-[0.98]"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-sm font-bold text-blue-900 group-hover:text-blue-700 transition-colors">{res.title}</span>
                        <div className="shrink-0 p-1.5 bg-white rounded-lg shadow-sm">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400 group-hover:text-blue-600"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </div>
                      </div>
                      <span className="text-[10px] text-blue-600 mt-2 block truncate font-medium">{res.uri}</span>
                    </a>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Emergency Alert Section - Always visible */}
          <div className="bg-amber-50 rounded-[2rem] p-6 md:p-8 border border-amber-100 shadow-sm">
            <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
              <div className="p-4 bg-white rounded-2xl shadow-md text-amber-600 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12" y1="17" y2="17.01"/></svg>
              </div>
              <div className="text-center sm:text-left">
                <h4 className="font-black text-amber-900 mb-2 uppercase text-sm tracking-widest flex items-center justify-center sm:justify-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping"></span>
                  জরুরি বিজ্ঞপ্তি
                </h4>
                <p className="text-amber-800 text-sm md:text-base leading-relaxed font-medium">
                  যদি আপনার বুকে ব্যথা বা তীব্র শ্বাসকষ্ট হয়, তবে এখনই কল কেটে <span className="text-red-700 font-bold bg-amber-100 px-2 py-0.5 rounded">৯০০</span> নম্বরে কল করুন অথবা দ্রুত নিকটস্থ হাসপাতালে যান।
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full bg-white border-t border-slate-200 mt-8">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-8 flex flex-col md:flex-row items-center justify-between gap-4 text-center md:text-left">
          <div className="text-slate-500 text-xs md:text-sm font-medium">
            <p>© 2026 হেলথ সাপোর্ট সেন্টার। আপনার তথ্য নিরাপদ।</p>
            <p className="mt-1 text-slate-400">ভয়েস, লোকেশন ও সার্চ তথ্য এনক্রিপ্টেড থাকে।</p>
          </div>
          <div className="flex flex-col md:items-end gap-1">
            <div className="px-3 py-1 bg-slate-100 rounded-lg text-[10px] md:text-xs font-bold text-slate-500 tracking-tight">
              JRRtech
            </div>
            <p className="text-[10px] md:text-xs text-slate-400 italic">Advanced Multimodal Healthcare Support</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
