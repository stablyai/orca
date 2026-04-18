// Display-name matches must always outrank path-only matches. This offset is
// added to every path-match score so that even a path hit at index 0 scores
// higher than the worst possible display-name hit. The value must exceed any
// realistic displayName length.
const PATH_SCORE_OFFSET = 1000;
function matchScore(repo, query) {
    const displayNameIndex = repo.displayName.toLowerCase().indexOf(query);
    if (displayNameIndex !== -1) {
        return displayNameIndex;
    }
    const pathIndex = repo.path.toLowerCase().indexOf(query);
    if (pathIndex !== -1) {
        // Why: repo-name matches are what issue #379 is about. Path search only
        // exists as a fallback disambiguator, so it should never outrank an actual
        // display-name match for the same query.
        return PATH_SCORE_OFFSET + pathIndex;
    }
    return null;
}
export function searchRepos(repos, rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
        return repos;
    }
    const matches = [];
    for (const [index, repo] of repos.entries()) {
        const score = matchScore(repo, query);
        if (score !== null) {
            matches.push({ repo, score, index });
        }
    }
    matches.sort((a, b) => a.score - b.score || a.index - b.index);
    return matches.map((match) => match.repo);
}
