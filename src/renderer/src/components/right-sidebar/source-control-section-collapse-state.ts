import { useCallback, useState } from 'react'
import type { SourceControlDisplaySectionId } from './source-control-section-order'

export type SourceControlCollapsibleSectionId = SourceControlDisplaySectionId | 'branch' | 'history'

const DEFAULT_COLLAPSED_SECTIONS: ReadonlySet<SourceControlCollapsibleSectionId> = new Set([
  'history'
])

// Why: Source Control unmounts with its sidebar tab, so a bounded session cache restores
// disclosure choices without promoting transient UI state to persistent settings.
export const MAX_PERSISTED_SOURCE_CONTROL_SECTION_STATES = 512
const collapsedSectionsByWorktreeId = new Map<
  string,
  ReadonlySet<SourceControlCollapsibleSectionId>
>()

function trimPersistedSectionStates(): void {
  while (collapsedSectionsByWorktreeId.size > MAX_PERSISTED_SOURCE_CONTROL_SECTION_STATES) {
    const oldestWorktreeId = collapsedSectionsByWorktreeId.keys().next().value
    if (oldestWorktreeId === undefined) {
      break
    }
    collapsedSectionsByWorktreeId.delete(oldestWorktreeId)
  }
}

function matchesDefaultState(
  collapsedSections: ReadonlySet<SourceControlCollapsibleSectionId>
): boolean {
  return (
    collapsedSections.size === DEFAULT_COLLAPSED_SECTIONS.size &&
    Array.from(DEFAULT_COLLAPSED_SECTIONS).every((section) => collapsedSections.has(section))
  )
}

function readCollapsedSections(
  worktreeId: string | null
): ReadonlySet<SourceControlCollapsibleSectionId> {
  return worktreeId
    ? (collapsedSectionsByWorktreeId.get(worktreeId) ?? DEFAULT_COLLAPSED_SECTIONS)
    : DEFAULT_COLLAPSED_SECTIONS
}

function persistCollapsedSections(
  worktreeId: string,
  collapsedSections: ReadonlySet<SourceControlCollapsibleSectionId>
): void {
  collapsedSectionsByWorktreeId.delete(worktreeId)
  if (matchesDefaultState(collapsedSections)) {
    return
  }
  collapsedSectionsByWorktreeId.set(worktreeId, collapsedSections)
  trimPersistedSectionStates()
}

export type SourceControlSectionCollapseControls = {
  collapsedSections: ReadonlySet<SourceControlCollapsibleSectionId>
  toggleSection: (section: SourceControlCollapsibleSectionId) => void
}

export function useSourceControlSectionCollapseState(
  worktreeId: string | null
): SourceControlSectionCollapseControls {
  const [rendered, setRendered] = useState<{
    worktreeId: string | null
    collapsedSections: ReadonlySet<SourceControlCollapsibleSectionId>
  }>(() => ({ worktreeId, collapsedSections: readCollapsedSections(worktreeId) }))

  // Why: the component stays mounted across worktree switches, so read the
  // incoming worktree's cache instead of briefly exposing the previous state.
  const collapsedSections =
    rendered.worktreeId === worktreeId
      ? rendered.collapsedSections
      : readCollapsedSections(worktreeId)

  const toggleSection = useCallback(
    (section: SourceControlCollapsibleSectionId): void => {
      if (!worktreeId) {
        return
      }
      const next = new Set(readCollapsedSections(worktreeId))
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      persistCollapsedSections(worktreeId, next)
      setRendered({ worktreeId, collapsedSections: next })
    },
    [worktreeId]
  )

  return { collapsedSections, toggleSection }
}

export function clearSourceControlSectionCollapseStateForTests(): void {
  collapsedSectionsByWorktreeId.clear()
}

export function getSourceControlSectionCollapseStateCountForTests(): number {
  return collapsedSectionsByWorktreeId.size
}

export function seedSourceControlSectionCollapseStateForTests(
  worktreeId: string,
  collapsedSections: ReadonlySet<SourceControlCollapsibleSectionId>
): void {
  persistCollapsedSections(worktreeId, collapsedSections)
}
