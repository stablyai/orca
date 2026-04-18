import type { StateCreator } from 'zustand';
import type { RateLimitState } from '../../../../shared/rate-limit-types';
import type { AppState } from '../types';
export type RateLimitSlice = {
    rateLimits: RateLimitState;
    fetchRateLimits: () => Promise<void>;
    refreshRateLimits: () => Promise<void>;
    setRateLimitsFromPush: (state: RateLimitState) => void;
};
export declare const createRateLimitSlice: StateCreator<AppState, [], [], RateLimitSlice>;
