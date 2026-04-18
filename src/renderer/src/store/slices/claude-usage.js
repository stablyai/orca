export const createClaudeUsageSlice = (set, get) => ({
    claudeUsageScope: 'orca',
    claudeUsageRange: '30d',
    claudeUsageScanState: null,
    claudeUsageSummary: null,
    claudeUsageDaily: [],
    claudeUsageModelBreakdown: [],
    claudeUsageProjectBreakdown: [],
    claudeUsageRecentSessions: [],
    setClaudeUsageEnabled: async (enabled) => {
        try {
            const nextScanState = (await window.api.claudeUsage.setEnabled({
                enabled
            }));
            set({
                // Why: every enable should look like a fresh scan cycle in the UI.
                // Reusing the last completed timestamp makes repeated toggles skip the
                // loading skeleton and briefly render an empty analytics pane.
                claudeUsageScanState: enabled
                    ? {
                        ...nextScanState,
                        isScanning: true,
                        lastScanCompletedAt: null,
                        lastScanError: null
                    }
                    : nextScanState,
                claudeUsageSummary: null,
                claudeUsageDaily: [],
                claudeUsageModelBreakdown: [],
                claudeUsageProjectBreakdown: [],
                claudeUsageRecentSessions: []
            });
            if (enabled) {
                await get().fetchClaudeUsage({ forceRefresh: true });
            }
        }
        catch (error) {
            console.error('Failed to update Claude usage setting:', error);
        }
    },
    setClaudeUsageScope: async (scope) => {
        set({ claudeUsageScope: scope });
        await get().fetchClaudeUsage();
    },
    setClaudeUsageRange: async (range) => {
        set({ claudeUsageRange: range });
        await get().fetchClaudeUsage();
    },
    fetchClaudeUsage: async (opts) => {
        try {
            const scanState = (await window.api.claudeUsage.getScanState());
            const currentScanState = get().claudeUsageScanState;
            const shouldPreserveLoadingState = opts?.forceRefresh === true &&
                currentScanState?.enabled === true &&
                get().claudeUsageSummary === null;
            set({
                claudeUsageScanState: shouldPreserveLoadingState
                    ? {
                        ...scanState,
                        isScanning: true,
                        lastScanCompletedAt: null,
                        lastScanError: null
                    }
                    : scanState
            });
            if (!scanState.enabled) {
                return;
            }
            const nextScanState = (await window.api.claudeUsage.refresh({
                force: opts?.forceRefresh ?? false
            }));
            const { claudeUsageScope, claudeUsageRange } = get();
            const [summary, daily, modelBreakdown, projectBreakdown, recentSessions] = await Promise.all([
                window.api.claudeUsage.getSummary({
                    scope: claudeUsageScope,
                    range: claudeUsageRange
                }),
                window.api.claudeUsage.getDaily({
                    scope: claudeUsageScope,
                    range: claudeUsageRange
                }),
                window.api.claudeUsage.getBreakdown({
                    scope: claudeUsageScope,
                    range: claudeUsageRange,
                    kind: 'model'
                }),
                window.api.claudeUsage.getBreakdown({
                    scope: claudeUsageScope,
                    range: claudeUsageRange,
                    kind: 'project'
                }),
                window.api.claudeUsage.getRecentSessions({
                    scope: claudeUsageScope,
                    range: claudeUsageRange,
                    limit: 10
                })
            ]);
            set({
                claudeUsageScanState: nextScanState,
                claudeUsageSummary: summary,
                claudeUsageDaily: daily,
                claudeUsageModelBreakdown: modelBreakdown,
                claudeUsageProjectBreakdown: projectBreakdown,
                claudeUsageRecentSessions: recentSessions
            });
        }
        catch (error) {
            console.error('Failed to fetch Claude usage:', error);
        }
    },
    enableClaudeUsage: async () => {
        await get().setClaudeUsageEnabled(true);
    },
    refreshClaudeUsage: async () => {
        await get().fetchClaudeUsage({ forceRefresh: true });
    }
});
