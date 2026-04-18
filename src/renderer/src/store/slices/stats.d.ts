import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { StatsSummary } from '../../../../shared/types';
export type StatsSlice = {
    statsSummary: StatsSummary | null;
    fetchStatsSummary: () => Promise<void>;
};
export declare const createStatsSlice: StateCreator<AppState, [], [], StatsSlice>;
