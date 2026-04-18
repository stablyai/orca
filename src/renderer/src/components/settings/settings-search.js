export function normalizeSettingsSearchQuery(query) {
    return query.trim().toLowerCase();
}
export function matchesSettingsSearch(query, entries) {
    const normalizedQuery = normalizeSettingsSearchQuery(query);
    if (!normalizedQuery) {
        return true;
    }
    const values = Array.isArray(entries) ? entries : [entries];
    return values.some((entry) => {
        const haystack = [entry.title, entry.description ?? '', ...(entry.keywords ?? [])];
        return haystack.some((value) => value.toLowerCase().includes(normalizedQuery));
    });
}
