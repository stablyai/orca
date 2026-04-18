import type { GitStagingArea } from '../../../../shared/types';
export type SourceControlAction = 'discard' | 'stage' | 'unstage';
export declare function getSourceControlActions(area: GitStagingArea): SourceControlAction[];
