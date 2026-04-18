import type { GlobalSettings } from '../../../../shared/types';
type TerminalPaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
    systemPrefersDark: boolean;
    terminalFontSuggestions: string[];
    scrollbackMode: 'preset' | 'custom';
    setScrollbackMode: (mode: 'preset' | 'custom') => void;
};
export declare function TerminalPane({ settings, updateSettings, systemPrefersDark, terminalFontSuggestions, scrollbackMode, setScrollbackMode }: TerminalPaneProps): React.JSX.Element;
export {};
