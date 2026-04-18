import type { GlobalSettings } from '../../../../shared/types';
import type { SettingsSearchEntry } from './settings-search';
export declare const NOTIFICATIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[];
type NotificationsPaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
};
export declare function NotificationsPane({ settings, updateSettings }: NotificationsPaneProps): React.JSX.Element;
export {};
