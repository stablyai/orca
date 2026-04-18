import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { GlobalSettings } from '../../../../shared/types';
export type SettingsSlice = {
    settings: GlobalSettings | null;
    settingsSearchQuery: string;
    setSettingsSearchQuery: (q: string) => void;
    fetchSettings: () => Promise<void>;
    updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>;
};
export declare const createSettingsSlice: StateCreator<AppState, [], [], SettingsSlice>;
