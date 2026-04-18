export function mergeTerminalThemeCatalogs(...catalogs) {
    const merged = {};
    for (const catalog of catalogs) {
        for (const [name, theme] of Object.entries(catalog)) {
            if (Object.prototype.hasOwnProperty.call(merged, name)) {
                throw new Error(`Duplicate terminal theme name: ${name}`);
            }
            merged[name] = theme;
        }
    }
    return merged;
}
