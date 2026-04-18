import type { GitFileStatus, GitStatusEntry } from '../../../../shared/types';
export declare const STATUS_LABELS: Record<GitFileStatus, string>;
export declare const STATUS_COLORS: Record<GitFileStatus, string>;
export declare function getDominantStatus(statuses: Iterable<GitFileStatus>): GitFileStatus | null;
export declare function buildStatusMap(entries: GitStatusEntry[]): Map<string, GitFileStatus>;
export declare function buildFolderStatusMap(entries: GitStatusEntry[]): Map<string, GitFileStatus | null>;
export declare function shouldPropagateStatus(status: GitFileStatus): boolean;
