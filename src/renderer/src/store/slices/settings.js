export const createSettingsSlice = (set) => ({
    settings: null,
    settingsSearchQuery: '',
    setSettingsSearchQuery: (q) => set({ settingsSearchQuery: q }),
    fetchSettings: async () => {
        try {
            const settings = await window.api.settings.get();
            set({ settings });
        }
        catch (err) {
            console.error('Failed to fetch settings:', err);
        }
    },
    updateSettings: async (updates) => {
        try {
            await window.api.settings.set(updates);
            set((s) => ({
                settings: s.settings
                    ? {
                        ...s.settings,
                        ...updates,
                        notifications: {
                            ...s.settings.notifications,
                            ...updates.notifications
                        }
                    }
                    : null
            }));
        }
        catch (err) {
            console.error('Failed to update settings:', err);
        }
    }
});
