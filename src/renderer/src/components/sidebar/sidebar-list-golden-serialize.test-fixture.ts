import type {
  WorktreeOccurrence,
  WorktreeOccurrencePlan
} from '../../../../shared/worktree-occurrence-plan'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../shared/sidebar-list/host-section-rows'
import type { VisibleWorktreeShortcutTarget } from './visible-worktrees'
import { getSidebarHeaderVisual } from './worktree-list/rows/header-visuals'

function iconName(icon: { displayName?: string; name?: string }): string {
  return icon.displayName ?? icon.name ?? 'anonymous'
}

function hostMap(map: ReadonlyMap<string, number | readonly string[]> | undefined): string {
  if (!map) {
    return '-'
  }
  return `{${[...map]
    .map(([host, value]) => `${host}:${typeof value === 'number' ? value : `[${value.join(',')}]`}`)
    .join(' ')}}`
}

/** The enclosing sections only, when the occurrence is nested deeper than its own section. */
function sectionPath(occurrence: WorktreeOccurrence<Worktree>): string | undefined {
  const keys: string[] = []
  for (let path: typeof occurrence.sectionPath | undefined = occurrence.sectionPath; path;) {
    keys.unshift(path.key)
    path = path.parent
  }
  return keys.length > 1 || keys[0] !== occurrence.sectionKey ? keys.join('>') : undefined
}

function field(name: string, value: string | number | boolean | undefined): string | null {
  return value === undefined || value === false ? null : `${name}=${value}`
}

function line(kind: string, fields: (string | null)[]): string {
  return [kind, ...fields.filter((entry) => entry !== null)].join(' ')
}

/** One stable line per row: every field a reader of the row model can observe. */
export function serializeSidebarRow(
  row: HostSectionRow,
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): string {
  switch (row.type) {
    case 'host-header':
      return line('HOST', [
        field('key', row.key),
        field('label', JSON.stringify(row.label)),
        field('kind', row.kind),
        field('detail', JSON.stringify(row.detail)),
        field('health', row.health),
        field('collapsed', row.collapsed),
        field('count', row.count)
      ])
    case 'header': {
      const headerVisual = getSidebarHeaderVisual(row.icon, workspaceStatuses)
      return line('HEADER', [
        field('key', row.key),
        field('collapseKey', row.collapseKey),
        field('label', JSON.stringify(row.label ?? headerVisual.label)),
        field('count', row.count),
        field('tone', JSON.stringify(headerVisual.tone)),
        field('icon', iconName(headerVisual.icon)),
        field('repo', row.repo?.id),
        field('projectGroup', row.projectGroup ? (row.projectGroup.id ?? 'ungrouped') : undefined),
        field('projectGroupDepth', row.projectGroupDepth),
        field('hostId', row.hostId),
        field('hostCounts', row.hostWorktreeCounts ? hostMap(row.hostWorktreeCounts) : undefined),
        field('hostIds', row.hostWorktreeIds ? hostMap(row.hostWorktreeIds) : undefined),
        field('ids', row.worktreeIds ? `[${row.worktreeIds.join(',')}]` : undefined)
      ])
    }
    case 'item':
      return line('ITEM', [
        field('rowKey', row.rowKey),
        field(
          'section',
          row.sectionKey === row.occurrence?.sectionKey ? undefined : row.sectionKey
        ),
        field(
          'wt',
          row.rowKey.endsWith(`:${getWorktreeHostIdentity(row.worktree)}`)
            ? undefined
            : getWorktreeHostIdentity(row.worktree)
        ),
        field('repo', row.repo?.id === row.worktree.repoId ? undefined : (row.repo?.id ?? 'none')),
        field('depth', row.depth),
        field('groupDepth', row.groupDepth),
        field('lastChild', row.isLastLineageChild),
        field('children', row.lineageChildCount),
        field('lineageKey', row.lineageGroupKey),
        field('lineageCollapsed', row.lineageCollapsed),
        field('hostLabel', row.hostContextLabel ? JSON.stringify(row.hostContextLabel) : undefined),
        field('showProject', row.showProjectName),
        field('occ', row.occurrence?.key === row.rowKey ? undefined : row.occurrence?.key),
        field('placement', row.occurrence?.placement),
        field('owning', row.occurrence?.owningSectionKey),
        field('path', row.occurrence ? sectionPath(row.occurrence) : undefined),
        field('parent', row.occurrence?.parent?.key)
      ])
    case 'pending-creation':
      return line('PENDING', [
        field('key', row.key),
        field('creation', row.creationId),
        field('repo', row.repo?.id)
      ])
    case 'imported-worktrees-card':
      return line('IMPORTED', [
        field('key', row.key),
        field('repo', row.repo.id),
        field('placement', row.placement),
        field('hidden', row.hiddenWorktrees.map((worktree) => worktree.id).join(',')),
        field('hostLabel', row.hostContextLabel ? JSON.stringify(row.hostContextLabel) : undefined),
        field('hostId', row.hostContextHostId)
      ])
    case 'new-external-worktrees-inbox':
      return line('INBOX', [
        field('key', row.key),
        field('repo', row.repo.id),
        field('inbox', row.inboxWorktrees.map((worktree) => worktree.id).join(',')),
        field('hostLabel', row.hostContextLabel ? JSON.stringify(row.hostContextLabel) : undefined),
        field('hostId', row.hostContextHostId)
      ])
    case 'folder-workspace':
      return line('FOLDER', [
        field('key', row.key),
        field('projectGroup', row.projectGroup.id),
        field('depth', row.depth),
        field('groupDepth', row.groupDepth)
      ])
  }
}

/** Plan entries the rows do not already show: hidden occurrences and duplicate-occurrence preferences. */
export function serializeOccurrencePlan(
  plan: WorktreeOccurrencePlan<Worktree>,
  renderedRowKeys: ReadonlySet<string>
): string[] {
  const lines: string[] = []
  const occurrenceCountByIdentity = new Map<string, number>()
  for (const [sectionKey, occurrences] of plan.bySection) {
    for (const occurrence of occurrences) {
      const identity = getWorktreeHostIdentity(occurrence.row)
      occurrenceCountByIdentity.set(identity, (occurrenceCountByIdentity.get(identity) ?? 0) + 1)
    }
    if (occurrences.length === 0 || occurrences.some(({ key }) => !renderedRowKeys.has(key))) {
      lines.push(`SECTION ${sectionKey}: ${occurrences.map(({ key }) => key).join(' ') || '-'}`)
    }
  }
  for (const [identity, occurrence] of plan.preferredByIdentity) {
    if ((occurrenceCountByIdentity.get(identity) ?? 0) > 1) {
      lines.push(`PREFERRED ${identity} -> ${occurrence.key}`)
    }
  }
  return lines
}

export function serializeShortcutTargets(
  targets: readonly VisibleWorktreeShortcutTarget[] | null
): string {
  if (!targets) {
    return 'null'
  }
  return (
    targets
      .slice(0, 9)
      .map(
        (target, index) =>
          `${index + 1}=${target.id}${target.executionHostId ? `@${target.executionHostId}` : ''}${
            target.lineageGroupKey ? `#${target.lineageGroupKey}` : ''
          }`
      )
      .join(' ') || '-'
  )
}
