import type React from 'react';
import { type SettingsSearchEntry } from './settings-search';
type SearchableSettingProps = SettingsSearchEntry & {
    children: React.ReactNode;
    className?: string;
};
export declare function SearchableSetting({ title, description, keywords, children, className }: SearchableSettingProps): React.JSX.Element | null;
export {};
