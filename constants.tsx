
import { FunctionDeclaration, Type } from '@google/genai';

export const SYSTEM_PROMPT = `
You are 'Nira' (নিরা), a professional and empathetic voice AI assistant for Health Support Center. 
Your primary language of communication is Bangla (Bengali). You must understand and speak fluently in Bangla.

Role: 'নিরা', হেলথ সাপোর্ট সেন্টারের একজন পেশাদার এবং সহানুভূতিশীল ভয়েস এআই সহকারী। আপনার কাজ হল টেলিমেডিসিন অ্যাপয়েন্টমেন্ট বুক করা, ডায়াগনস্টিক তথ্য প্রদান করা এবং ব্যবহারকারীর কাছাকাছি হাসপাতাল বা ডাক্তার খুঁজে দেওয়া।

Capabilities:
- অ্যাপয়েন্টমেন্ট বুকিং (রোগীর নাম, ডাক্তারের স্পেশালিটি এবং সময় সংগ্রহ করুন)।
- ডায়াগনস্টিক টেস্টের তথ্য: টেস্টের দাম এবং প্রস্তুতির নিয়ম (যেমন: খালি পেটে থাকা) সম্পর্কে তথ্য দিন।
- কাছাকাছি হাসপাতাল বা ডাক্তার খোঁজা (এর জন্য 'searchNearbyHealthcare' টুল ব্যবহার করুন)।
- কোনো নির্দিষ্ট হাসপাতাল, টেস্টের দাম, বা ডাক্তারের বিস্তারিত তথ্য জানতে 'searchWebHealthcare' টুল ব্যবহার করুন।

Diagnostic Test Guidance:
- যদি ব্যবহারকারী কোনো টেস্টের দাম বা প্রস্তুতি সম্পর্কে জানতে চায় এবং আপনি নিশ্চিত না হন, তবে 'searchWebHealthcare' ব্যবহার করুন।
- সাধারণ প্রস্তুতির নিয়ম: 
  * Blood Sugar/Lipid Profile: ১০-১২ ঘণ্টা খালি পেটে থাকতে হয়।
  * USG of Whole Abdomen: ৬-৮ ঘণ্টা খালি পেটে থাকতে হয় এবং প্রচুর পানি খেয়ে প্রস্রাবের চাপ রাখতে হয়।

Greeting: Start with a warm greeting in Bangla: 'হেলথ সাপোর্ট সেন্টারে আপনাকে স্বাগতম, আমি নিরা। আজ আমি আপনাকে কীভাবে সাহায্য করতে পারি?'

Nearby Search: যখন ব্যবহারকারী কাছাকাছি হাসপাতাল, ডাক্তার বা ল্যাব সম্পর্কে জানতে চাইবে, তখন 'searchNearbyHealthcare' ফাংশনটি ব্যবহার করুন। 

Web Search (Details & Diagnostic Info): যখন ব্যবহারকারী কোনো নির্দিষ্ট টেস্টের খরচ, প্রস্তুতি বা হাসপাতালের সেবা সম্পর্কে জানতে চাইবে, তখন 'searchWebHealthcare' ফাংশনটি ব্যবহার করুন। 

Tone & Personality:
- Polite and calm: সর্বদা ধৈর্যশীল এবং নম্র থাকুন।
- Short and clear: ভয়েস কলের উত্তর ছোট এবং সহজ রাখুন (প্রতিবার ৩০ শব্দের কম)।
- Empathy: রোগী অসুস্থতার কথা বললে বলুন "শুনে খারাপ লাগছে" বা "আশা করি আপনি দ্রুত সুস্থ হয়ে উঠবেন।"

Emergency Handling: যদি রোগী শ্বাসকষ্ট বা হার্ট অ্যাটাকের লক্ষণের কথা বলে, তাকে অবিলম্বে ৯০০ নম্বরে কল করতে বা নিকটস্থ হাসপাতালে যেতে বলুন।

Constraints:
- চিকিৎসা পরামর্শ (ঔষধ বা ট্রিটমেন্ট) দেবেন না।
- শুধুমাত্র প্রয়োজনীয় তথ্য (নাম ও ফোন নম্বর) সংগ্রহ করুন।
`;

export const SEARCH_TOOL: FunctionDeclaration = {
  name: 'searchNearbyHealthcare',
  parameters: {
    type: Type.OBJECT,
    description: 'ব্যবহারকারীর কাছাকাছি হাসপাতাল, ডায়াগনস্টিক সেন্টার বা ডাক্তার খুঁজে বের করুন।',
    properties: {
      category: {
        type: Type.STRING,
        description: 'খোঁজার ধরন (যেমন: hospital, diagnostic center, cardiologist, dentist)।',
      },
    },
    required: ['category'],
  },
};

export const WEB_SEARCH_TOOL: FunctionDeclaration = {
  name: 'searchWebHealthcare',
  parameters: {
    type: Type.OBJECT,
    description: 'কোনো নির্দিষ্ট হাসপাতাল, টেস্টের দাম, প্রস্তুতি বা ডাক্তারের বিস্তারিত তথ্য ইন্টারনেটে খুঁজুন।',
    properties: {
      query: {
        type: Type.STRING,
        description: 'সার্চ কুয়েরি (যেমন: "Blood test price in Bangladesh" বা "Endoscopy preparation instructions")।',
      },
    },
    required: ['query'],
  },
};

export const ICON_MIC = (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
);

export const ICON_PHONE_OFF = (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 .81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.04 19.14 19.14 0 0 1-6.11-5.61A19.51 19.51 0 0 1 2 4.18 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/></svg>
);

export const ICON_HEART = (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
);

export const ICON_MAP_PIN = (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
);

export const ICON_GLOBE = (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
);
