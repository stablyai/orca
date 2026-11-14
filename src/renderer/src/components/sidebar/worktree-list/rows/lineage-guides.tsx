import React from 'react'
import { cn } from '@/lib/class-names'
import type { LineageRail, LineageRowGuides } from '../listing/lineage-row-projection'

// Why: the card's title row center; single-line cards override it in CSS via :has().
const TITLE_CENTER = 'var(--worktree-lineage-title-center, 16px)'
// Why: starts the stem just under the parent's status-lane icon instead of crossing it.
const STEM_TOP_BELOW_TITLE = 12

function railXs(rail: LineageRail | null): number[] {
  const xs: number[] = []
  for (let node = rail; node; node = node.next) {
    xs.push(node.x)
  }
  return xs
}

/** Tree connectors for one virtual row; each row paints only its own slice so lines survive virtualization. */
export function LineageGuides({
  guides,
  before,
  hidden
}: {
  guides: LineageRowGuides
  before: number
  hidden: boolean
}): React.JSX.Element {
  const titleCenter = `calc(${before}px + ${TITLE_CENTER})`
  const { branch } = guides
  return (
    <div
      aria-hidden="true"
      data-worktree-lineage-guides=""
      className={cn('pointer-events-none absolute inset-0', hidden && 'opacity-0')}
    >
      {railXs(guides.rails).map((x) => (
        <span
          key={x}
          data-worktree-lineage-guide="rail"
          className="absolute top-0 bottom-0 w-px"
          style={{ left: x }}
        />
      ))}
      {branch && !branch.last && (
        <>
          <span
            data-worktree-lineage-guide="rail"
            className="absolute top-0 bottom-0 w-px"
            style={{ left: branch.x }}
          />
          {/* Why: a tee, not an elbow, so translucent strokes never overlap and double up. */}
          <span
            data-worktree-lineage-guide="rail"
            className="absolute h-px"
            style={{
              left: branch.x + 1,
              width: Math.max(0, branch.to - branch.x - 1),
              top: titleCenter
            }}
          />
        </>
      )}
      {branch?.last && (
        <span
          data-worktree-lineage-guide="branch"
          className="absolute top-0 rounded-bl-[6px] border-b border-l"
          style={{
            left: branch.x,
            width: Math.max(0, branch.to - branch.x),
            height: `calc(${titleCenter} + 1px)`
          }}
        />
      )}
      {guides.stem !== null && (
        <span
          data-worktree-lineage-guide="stem"
          className="absolute bottom-0 w-px"
          style={{
            left: guides.stem,
            top: `calc(${titleCenter} + ${STEM_TOP_BELOW_TITLE}px)`
          }}
        />
      )}
    </div>
  )
}
