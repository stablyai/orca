import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'

export function buildCombinedGitStatusSignature(
  sections: readonly { path: string }[],
  gitStatusEntries: readonly GitStatusEntry[]
): string {
  return JSON.stringify(getCombinedGitStatusEntries(sections, gitStatusEntries))
}

export function buildCombinedGitStatusSnapshot(
  sections: readonly { path: string }[],
  gitStatusEntries: readonly GitStatusEntry[]
): { signature: string; pathSignatures: ReadonlyMap<string, string> } {
  const matching = getCombinedGitStatusEntries(sections, gitStatusEntries)
  const entriesByPath = new Map<string, typeof matching>()
  for (const entry of matching) {
    const entries = entriesByPath.get(entry.path)
    if (entries) {
      entries.push(entry)
    } else {
      entriesByPath.set(entry.path, [entry])
    }
  }
  return {
    signature: JSON.stringify(matching),
    pathSignatures: new Map(
      [...entriesByPath].map(([path, entries]) => [
        path,
        JSON.stringify(entries.sort((left, right) => left.area.localeCompare(right.area)))
      ])
    )
  }
}

function getCombinedGitStatusEntries(
  sections: readonly { path: string }[],
  gitStatusEntries: readonly GitStatusEntry[]
) {
  const sectionPaths = new Set(sections.map((section) => section.path))
  return gitStatusEntries
    .filter((entry) => sectionPaths.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      oldPath: entry.oldPath ?? null,
      area: entry.area,
      status: entry.status,
      added: entry.added ?? null,
      removed: entry.removed ?? null
    }))
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
