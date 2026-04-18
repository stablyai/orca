import React from 'react';
import type { Worktree, Repo } from '../../../../shared/types';
type WorktreeCardProps = {
    worktree: Worktree;
    repo: Repo | undefined;
    isActive: boolean;
    hideRepoBadge?: boolean;
    /** 1-9 hint badge shown when the user holds the platform modifier key. */
    hintNumber?: number;
};
declare const WorktreeCard: React.NamedExoticComponent<WorktreeCardProps>;
export default WorktreeCard;
