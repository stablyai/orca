/**
 * Per-worktree prompt-cache countdown, shown in the sidebar worktree card.
 *
 * When a worktree has multiple Claude tabs, the timer shows the *most urgent*
 * (shortest remaining) countdown — if any tab's cache is about to expire, the
 * user should know.
 *
 * Why: prompt caching (Anthropic API / Bedrock) has a TTL (default 5 min).
 * When the cache expires, the next request re-sends the full conversation as
 * uncached input tokens — up to 10x more expensive. Showing a countdown lets
 * users decide whether to resume interaction before the cache drops.
 */
export default function CacheTimer({ worktreeId }: {
    worktreeId: string;
}): React.JSX.Element | null;
