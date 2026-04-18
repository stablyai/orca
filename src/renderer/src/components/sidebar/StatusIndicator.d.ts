import React from 'react';
import type { WorktreeStatus } from '@/lib/worktree-status';
type StatusIndicatorProps = React.ComponentProps<'span'> & {
    status: WorktreeStatus;
};
declare const StatusIndicator: React.NamedExoticComponent<StatusIndicatorProps>;
export default StatusIndicator;
export type { WorktreeStatus as Status };
