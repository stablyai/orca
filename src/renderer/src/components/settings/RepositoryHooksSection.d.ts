import type { OrcaHooks, Repo, SetupRunPolicy } from '../../../../shared/types';
type RepositoryHooksSectionProps = {
    repo: Repo;
    yamlHooks: OrcaHooks | null;
    hasHooksFile: boolean;
    mayNeedUpdate: boolean;
    copiedTemplate: boolean;
    onCopyTemplate: () => void;
    onClearLegacyHooks: () => void;
    onUpdateSetupRunPolicy: (policy: SetupRunPolicy) => void;
};
export declare function RepositoryHooksSection({ repo, yamlHooks, hasHooksFile, mayNeedUpdate, copiedTemplate, onCopyTemplate, onClearLegacyHooks, onUpdateSetupRunPolicy }: RepositoryHooksSectionProps): React.JSX.Element;
export {};
