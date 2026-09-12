/**
 * Parses `git clone --progress` stderr fragments into progress updates.
 *
 * Git emits progress on stderr as `\r`-overwritten lines like
 * `Receiving objects:  42% (420/1000)`. A single stderr chunk may hold several
 * such fragments (or a partial one), so callers pass each chunk verbatim and
 * receive zero or more parsed updates. Early phases ("remote: Enumerating
 * objects", connection setup) carry no percentage and yield nothing.
 *
 * Lives in shared/ so every clone backend — local main process, SSH relay, and
 * runtime environment — parses progress identically (AGENTS.md cross-host parity).
 */
export type GitCloneProgress = { phase: string; percent: number }

const CLONE_PROGRESS_LINE = /^([\w\s]+):\s+(\d+)%/

/** Parses `git clone --progress` stderr into phase/percent updates. */
export function parseGitCloneProgress(text: string): GitCloneProgress[] {
  const updates: GitCloneProgress[] = []
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(CLONE_PROGRESS_LINE)
    if (match) {
      updates.push({ phase: match[1].trim(), percent: Number.parseInt(match[2], 10) })
    }
  }
  return updates
}
