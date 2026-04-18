import { type EffectiveTerminalAppearance } from '@/lib/terminal-theme';
type TerminalThemePreviewProps = {
    title: string;
    description: string;
    appearance: EffectiveTerminalAppearance;
    dividerThicknessPx?: number;
    inactivePaneOpacity?: number;
    activePaneOpacity?: number;
};
export declare function TerminalThemePreview({ title, description, appearance, dividerThicknessPx, inactivePaneOpacity, activePaneOpacity }: TerminalThemePreviewProps): React.JSX.Element;
export {};
