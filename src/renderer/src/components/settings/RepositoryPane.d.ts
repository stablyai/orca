import type { OrcaHooks, Repo } from '../../../../shared/types';
import { type SettingsSearchEntry } from './settings-search';
type RepositoryPaneProps = {
    repo: Repo;
    yamlHooks: OrcaHooks | null;
    hasHooksFile: boolean;
    mayNeedUpdate: boolean;
    updateRepo: (repoId: string, updates: Partial<Repo>) => void;
    removeRepo: (repoId: string) => void;
};
export declare function getRepositoryPaneSearchEntries(repo: Repo): SettingsSearchEntry[];
export declare function RepositoryPane({ repo, yamlHooks, hasHooksFile, mayNeedUpdate, updateRepo, removeRepo }: RepositoryPaneProps): React.JSX.Element;
export {};
