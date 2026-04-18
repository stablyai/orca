import type { StateCreator } from 'zustand';
import type { ClaudeUsageBreakdownRow, ClaudeUsageDailyPoint, ClaudeUsageRange, ClaudeUsageScanState, ClaudeUsageScope, ClaudeUsageSessionRow, ClaudeUsageSummary } from '../../../../shared/claude-usage-types';
import type { AppState } from '../types';
export type ClaudeUsageSlice = {
    claudeUsageScope: ClaudeUsageScope;
    claudeUsageRange: ClaudeUsageRange;
    claudeUsageScanState: ClaudeUsageScanState | null;
    claudeUsageSummary: ClaudeUsageSummary | null;
    claudeUsageDaily: ClaudeUsageDailyPoint[];
    claudeUsageModelBreakdown: ClaudeUsageBreakdownRow[];
    claudeUsageProjectBreakdown: ClaudeUsageBreakdownRow[];
    claudeUsageRecentSessions: ClaudeUsageSessionRow[];
    setClaudeUsageEnabled: (enabled: boolean) => Promise<void>;
    setClaudeUsageScope: (scope: ClaudeUsageScope) => Promise<void>;
    setClaudeUsageRange: (range: ClaudeUsageRange) => Promise<void>;
    fetchClaudeUsage: (opts?: {
        forceRefresh?: boolean;
    }) => Promise<void>;
    enableClaudeUsage: () => Promise<void>;
    refreshClaudeUsage: () => Promise<void>;
};
export declare const createClaudeUsageSlice: StateCreator<AppState, [], [], ClaudeUsageSlice>;
