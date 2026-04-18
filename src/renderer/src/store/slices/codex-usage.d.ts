import type { StateCreator } from 'zustand';
import type { CodexUsageBreakdownRow, CodexUsageDailyPoint, CodexUsageRange, CodexUsageScanState, CodexUsageScope, CodexUsageSessionRow, CodexUsageSummary } from '../../../../shared/codex-usage-types';
import type { AppState } from '../types';
export type CodexUsageSlice = {
    codexUsageScope: CodexUsageScope;
    codexUsageRange: CodexUsageRange;
    codexUsageScanState: CodexUsageScanState | null;
    codexUsageSummary: CodexUsageSummary | null;
    codexUsageDaily: CodexUsageDailyPoint[];
    codexUsageModelBreakdown: CodexUsageBreakdownRow[];
    codexUsageProjectBreakdown: CodexUsageBreakdownRow[];
    codexUsageRecentSessions: CodexUsageSessionRow[];
    setCodexUsageEnabled: (enabled: boolean) => Promise<void>;
    setCodexUsageScope: (scope: CodexUsageScope) => Promise<void>;
    setCodexUsageRange: (range: CodexUsageRange) => Promise<void>;
    fetchCodexUsage: (opts?: {
        forceRefresh?: boolean;
    }) => Promise<void>;
    enableCodexUsage: () => Promise<void>;
    refreshCodexUsage: () => Promise<void>;
};
export declare const createCodexUsageSlice: StateCreator<AppState, [], [], CodexUsageSlice>;
