import type { GlobalSettings } from '../../../../shared/types';
import { BROWSER_PANE_SEARCH_ENTRIES } from './browser-search';
export { BROWSER_PANE_SEARCH_ENTRIES };
type BrowserPaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
};
export declare function BrowserPane({ settings, updateSettings }: BrowserPaneProps): React.JSX.Element;
