export const createStatsSlice = (set) => ({
    statsSummary: null,
    fetchStatsSummary: async () => {
        try {
            const summary = await window.api.stats.getSummary();
            set({ statsSummary: summary });
        }
        catch (err) {
            console.error('Failed to fetch stats summary:', err);
        }
    }
});
