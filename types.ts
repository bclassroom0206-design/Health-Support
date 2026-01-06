
export enum CallStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR',
}

export interface TranscriptionEntry {
  role: 'user' | 'nira';
  text: string;
  timestamp: number;
}

export interface PatientRecord {
  id: string;
  name: string;
  email: string;
  phone: string;
  timestamp: number;
  status: 'new' | 'contacted' | 'booked';
}

export interface CallHistoryEntry {
  id: string;
  timestamp: number;
  summary: string;
  transcript: TranscriptionEntry[];
}

export type AppView = 'assistant' | 'admin' | 'guide' | 'history';
