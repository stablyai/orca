import type React from 'react';
import { type SettingsSearchEntry } from './settings-search';
type SettingsSectionProps = {
    id: string;
    title: string;
    description: string;
    searchEntries: SettingsSearchEntry[];
    children: React.ReactNode;
    className?: string;
    badge?: string;
};
export declare function SettingsSection({ id, title, description, searchEntries, children, className, badge }: SettingsSectionProps): React.JSX.Element | null;
export {};
