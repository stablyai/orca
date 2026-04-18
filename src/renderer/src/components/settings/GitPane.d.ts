import type { GlobalSettings } from '../../../../shared/types';
import { GIT_PANE_SEARCH_ENTRIES } from './git-search';
export { GIT_PANE_SEARCH_ENTRIES };
type GitPaneProps = {
    settings: GlobalSettings;
    updateSettings: (updates: Partial<GlobalSettings>) => void;
    displayedGitUsername: string;
};
export declare function GitPane({ settings, updateSettings, displayedGitUsername }: GitPaneProps): React.JSX.Element;
