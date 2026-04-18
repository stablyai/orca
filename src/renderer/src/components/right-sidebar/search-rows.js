export function buildSearchRows(results, collapsedFiles) {
    if (!results) {
        return [];
    }
    // Why: the summary row is rendered as a fixed header in Search.tsx so it
    // stays visible while the user scrolls through results and doesn't
    // participate in virtualisation.
    const rows = [];
    for (const fileResult of results.files) {
        const collapsed = collapsedFiles.has(fileResult.filePath);
        rows.push({ type: 'file', fileResult, collapsed });
        // Why: flattening the tree into rows lets the sidebar virtualize search
        // output. Rendering every file header and every match at once is what made
        // large ripgrep result sets freeze the renderer.
        if (collapsed) {
            continue;
        }
        for (const [matchIndex, match] of fileResult.matches.entries()) {
            rows.push({
                type: 'match',
                fileResult,
                match,
                matchIndex
            });
        }
    }
    return rows;
}
