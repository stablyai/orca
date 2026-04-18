import type { ITheme } from '@xterm/xterm';
export declare const TERMINAL_THEMES: Record<string, ITheme>;
export declare function getThemeNames(): string[];
export declare function getTheme(name: string): ITheme | null;
