import type { GlobalSettings } from '../../../../shared/types';
import { GENERAL_PANE_SEARCH_ENTRIES } from './general-search';
export { GENERAL_PANE_SEARCH_ENTRIES };
type GeneralPaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
};
export declare function GeneralPane({ settings, updateSettings }: GeneralPaneProps): React.JSX.Element;
