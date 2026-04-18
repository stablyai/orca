export const createRateLimitSlice = (set) => ({
    rateLimits: { claude: null, codex: null },
    fetchRateLimits: async () => {
        try {
            const state = await window.api.rateLimits.get();
            set({ rateLimits: state });
        }
        catch (error) {
            console.error('Failed to fetch rate limits:', error);
        }
    },
    refreshRateLimits: async () => {
        try {
            const state = await window.api.rateLimits.refresh();
            set({ rateLimits: state });
        }
        catch (error) {
            console.error('Failed to refresh rate limits:', error);
        }
    },
    setRateLimitsFromPush: (state) => {
        set({ rateLimits: state });
    }
});
