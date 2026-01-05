
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
