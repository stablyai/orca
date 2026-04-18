import React from 'react';
import type { PRState, CheckStatus, GitConflictOperation, TerminalTab } from '../../../../shared/types';
export declare function branchDisplayName(branch: string): string;
export declare function prStateLabel(state: PRState): string;
export declare function checksLabel(status: CheckStatus): string;
export declare const CONFLICT_OPERATION_LABELS: Record<Exclude<GitConflictOperation, 'unknown'>, string>;
export declare const EMPTY_TABS: TerminalTab[];
export declare const EMPTY_BROWSER_TABS: {
    id: string;
}[];
export declare function FilledBellIcon({ className }: {
    className?: string;
}): React.JSX.Element;
export declare function PullRequestIcon({ className }: {
    className?: string;
}): React.JSX.Element;
