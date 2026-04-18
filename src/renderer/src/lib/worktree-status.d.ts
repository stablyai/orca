import type { TerminalTab } from '../../../shared/types';
export type WorktreeStatus = 'active' | 'working' | 'permission' | 'inactive';
export declare function getWorktreeStatus(tabs: Pick<TerminalTab, 'ptyId' | 'title'>[], browserTabs: {
    id: string;
}[]): WorktreeStatus;
export declare function getWorktreeStatusLabel(status: WorktreeStatus): string;
