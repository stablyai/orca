export function shouldIncludeFileExplorerEntry(entry) {
    return entry.name !== '.git' && entry.name !== 'node_modules';
}
