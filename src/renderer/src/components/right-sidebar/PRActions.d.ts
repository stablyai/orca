import React from 'react';
import type { PRInfo, Repo, Worktree } from '../../../../shared/types';
export default function PRActions({ pr, repo, worktree, onRefreshPR }: {
    pr: PRInfo;
    repo: Repo;
    worktree: Worktree;
    onRefreshPR: () => Promise<void>;
}): React.JSX.Element | null;
