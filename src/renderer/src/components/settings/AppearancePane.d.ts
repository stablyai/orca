import type { GlobalSettings } from '../../../../shared/types';
import { type SettingsSearchEntry } from './settings-search';
type AppearancePaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
    applyTheme: (theme: 'system' | 'dark' | 'light') => void;
};
export declare const APPEARANCE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare function AppearancePane({ settings, updateSettings, applyTheme }: AppearancePaneProps): React.JSX.Element;
export {};
