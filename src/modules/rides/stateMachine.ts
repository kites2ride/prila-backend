import type { RideStatus } from './model.js';

const TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  requested: ['searching', 'cancelled_by_rider', 'cancelled_by_system'],
  searching: [
    'pilot_assigned',
    'no_pilot_found',
    'cancelled_by_rider',
    'cancelled_by_system',
    'searching', // retry batch
  ],
  pilot_assigned: [
    'pilot_arriving',
    'cancelled_by_rider',
    'cancelled_by_pilot',
    'cancelled_by_system',
    'searching', // pilot skip / timeout re-search
  ],
  pilot_arriving: [
    'pilot_arrived',
    'searching', // pilot cancelled → find another pilot
    'cancelled_by_rider',
    'cancelled_by_pilot',
    'cancelled_by_system',
  ],
  pilot_arrived: [
    'in_progress',
    'searching', // pilot cancelled → find another pilot
    'cancelled_by_rider',
    'cancelled_by_pilot',
    'cancelled_by_system',
  ],
  in_progress: ['completed', 'cancelled_by_system'],
  completed: ['paid'],
  paid: [],
  cancelled_by_rider: [],
  cancelled_by_pilot: [],
  cancelled_by_system: [],
  no_pilot_found: [],
};

export function canTransition(from: RideStatus, to: RideStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: RideStatus, to: RideStatus): void {
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`Invalid transition ${from} → ${to}`), {
      code: 'RIDE_STATE_INVALID',
    });
  }
}

export const ACTIVE_RIDER_STATUSES: RideStatus[] = [
  'requested',
  'searching',
  'pilot_assigned',
  'pilot_arriving',
  'pilot_arrived',
  'in_progress',
];

export const ACTIVE_PILOT_STATUSES: RideStatus[] = [
  'pilot_assigned',
  'pilot_arriving',
  'pilot_arrived',
  'in_progress',
];
