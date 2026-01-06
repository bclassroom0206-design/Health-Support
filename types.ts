
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

// Healthcare Database Interfaces
export interface DoctorEntry { id: string; name: string; specialty: string; hospital: string; contact: string; }
export interface DiagnosticEntry { id: string; name: string; tests: string; location: string; contact: string; }
export interface HospitalEntry { id: string; name: string; services: string; address: string; emergency: string; }
export interface MedicineEntry { id: string; name: string; type: string; indications: string; }
export interface FirstAidEntry { id: string; condition: string; instructions: string; }

export interface HealthDatabase {
  doctors: DoctorEntry[];
  diagnostics: DiagnosticEntry[];
  hospitals: HospitalEntry[];
  medicines: MedicineEntry[];
  firstAid: FirstAidEntry[];
}

export type AppView = 'assistant' | 'admin' | 'guide' | 'history' | 'database';
