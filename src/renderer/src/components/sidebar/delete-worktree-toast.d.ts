export type DeleteWorktreeToastCopy = {
    title: string;
    description?: string;
    isDestructive: boolean;
};
export declare function getDeleteWorktreeToastCopy(worktreeName: string, canForceDelete: boolean, error: string): DeleteWorktreeToastCopy;
