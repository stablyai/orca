import type { GlobalSettings } from '../../../../shared/types';
export { AGENTS_PANE_SEARCH_ENTRIES } from './agents-search';
type AgentsPaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
};
export declare function AgentsPane({ settings, updateSettings }: AgentsPaneProps): React.JSX.Element;
