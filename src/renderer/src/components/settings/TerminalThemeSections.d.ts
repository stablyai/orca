import type { Dispatch, SetStateAction } from 'react';
import type { GlobalSettings } from '../../../../shared/types';
import type { EffectiveTerminalAppearance } from '@/lib/terminal-theme';
type ThemePreviewProps = {
    dividerThicknessPx: number;
    inactivePaneOpacity: number;
    activePaneOpacity: number;
};
type DarkTerminalThemeSectionProps = {
    settings: GlobalSettings;
    systemPrefersDark: boolean;
    themeSearchDark: string;
    setThemeSearchDark: Dispatch<SetStateAction<string>>;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
    previewProps: ThemePreviewProps;
    darkPreviewAppearance: EffectiveTerminalAppearance;
};
type LightTerminalThemeSectionProps = {
    settings: GlobalSettings;
    themeSearchLight: string;
    setThemeSearchLight: Dispatch<SetStateAction<string>>;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
    previewProps: ThemePreviewProps;
    lightPreviewAppearance: EffectiveTerminalAppearance;
};
export declare function DarkTerminalThemeSection({ settings, systemPrefersDark, themeSearchDark, setThemeSearchDark, updateSettings, previewProps, darkPreviewAppearance }: DarkTerminalThemeSectionProps): React.JSX.Element;
export declare function LightTerminalThemeSection({ settings, themeSearchLight, setThemeSearchLight, updateSettings, previewProps, lightPreviewAppearance }: LightTerminalThemeSectionProps): React.JSX.Element;
export {};
