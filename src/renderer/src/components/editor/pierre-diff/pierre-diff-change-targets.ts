import type { FileDiffMetadata } from '@pierre/diffs'

export type PierreDiffChangeTarget = { lineNumber: number; side: 'additions' | 'deletions' }

export function getPierreDiffChangeTargets(
  diff: FileDiffMetadata | null
): PierreDiffChangeTarget[] {
  const targets: PierreDiffChangeTarget[] = []
  for (const hunk of diff?.hunks ?? []) {
    let additionLine = hunk.additionStart
    let deletionLine = hunk.deletionStart
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        additionLine += block.lines
        deletionLine += block.lines
      } else {
        targets.push(
          block.additions > 0
            ? { lineNumber: Math.max(1, additionLine), side: 'additions' }
            : { lineNumber: Math.max(1, deletionLine), side: 'deletions' }
        )
        additionLine += block.additions
        deletionLine += block.deletions
      }
    }
  }
  return targets
}
