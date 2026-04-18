import type { DiffComment } from '../../../../shared/types';
export declare function DiffCommentsAgentChooserDialog({ open, onOpenChange, worktreeId, comments }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    worktreeId: string;
    comments: DiffComment[];
}): React.JSX.Element | null;
