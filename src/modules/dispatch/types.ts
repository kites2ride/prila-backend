export type PilotDispatchStatus = 'idle' | 'offered' | 'on_ride';

export type PilotLiveState = {
  pilotId: string;
  lat: number;
  lng: number;
  cell: string;
  headingDeg?: number;
  speedMps?: number;
  accuracyM?: number;
  updatedAt: number;
  status: PilotDispatchStatus;
  offerRideId?: string;
  offerExpiresAt?: number;
  serviceTypes: string[];
  vehicleType?: string;
  cityId?: string;
  gender?: string;
  shaktiOptIn?: boolean;
  kycStatus?: string;
  online: boolean;
  flaggedMocked?: boolean;
};

export type DispatchLogEntry = {
  at: string;
  event: string;
  cells?: string[];
  candidateCount?: number;
  pilotIds?: string[];
  note?: string;
  ms?: number;
};

export type Candidate = {
  pilotId: string;
  lat: number;
  lng: number;
  cell: string;
  distanceM: number;
  vehicleType?: string;
};
