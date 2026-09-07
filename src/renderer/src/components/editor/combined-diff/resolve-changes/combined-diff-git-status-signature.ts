import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'

export function buildCombinedGitStatusSignature(
  sections: readonly { path: string }[],
  gitStatusEntries: readonly GitStatusEntry[]
): string {
  const sectionPaths = new Set(sections.map((section) => section.path))
  const matching = gitStatusEntries.filter((entry) => sectionPaths.has(entry.path))
  return JSON.stringify(
    matching.map((entry) => ({
      path: entry.path,
      oldPath: entry.oldPath ?? null,
      area: entry.area,
      status: entry.status,
      added: entry.added ?? null,
      removed: entry.removed ?? null
    }))
  )
}

export function getRetainedResolvedSnapshotEntries(
  sections: readonly DiffSection[]
): GitStatusEntry[] {
  return sections.flatMap((section) =>
    section.area === undefined
      ? []
      : [
          {
            path: section.path,
            status: section.status as GitStatusEntry['status'],
            area: section.area,
            oldPath: section.oldPath,
            added: section.added,
            removed: section.removed
          }
        ]
  )
}
