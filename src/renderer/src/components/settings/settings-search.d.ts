export type SettingsSearchEntry = {
    title: string;
    description?: string;
    keywords?: string[];
};
export declare function normalizeSettingsSearchQuery(query: string): string;
export declare function matchesSettingsSearch(query: string, entries: SettingsSearchEntry | SettingsSearchEntry[]): boolean;
