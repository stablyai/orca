export type RepoSlug = {
    owner: string;
    repo: string;
};
export type GitHubLinkQuery = {
    query: string;
    repoMismatch: string | null;
    directNumber: number | null;
};
/**
 * Parses a GitHub issue/PR reference from plain input.
 * Supports issue/PR numbers (e.g. "42"), "#42", and full GitHub URLs.
 */
export declare function parseGitHubIssueOrPRNumber(input: string): number | null;
/**
 * Parses an owner/repo slug plus issue/PR number from a GitHub URL. Returns
 * null for anything that isn't a recognizable github.com issue or pull URL.
 */
export declare function parseGitHubIssueOrPRLink(input: string): {
    slug: RepoSlug;
    number: number;
} | null;
/**
 * Normalizes link-picker input so both raw issue/PR numbers and full GitHub
 * URLs resolve to a usable query + direct-number lookup. Returns a repo
 * mismatch when a URL targets a different repo than the selected one.
 */
export declare function normalizeGitHubLinkQuery(raw: string, repoSlug: RepoSlug | null): GitHubLinkQuery;
