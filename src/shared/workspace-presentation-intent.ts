import type { Tab, TabGroup, TabGroupLayoutNode } from './tab-types'
import {
  tabPresentation,
  workspacePresentationKey,
  type WorkspacePresentation,
  type WorkspacePresentationDocuments,
  type WorkspaceSourceRef
} from './workspace-presentation'
import { editWorkspacePresentationDocuments } from './workspace-presentation-documents'
import { noteWorkspacePresentationUserIntent } from './workspace-presentation-user-intent'

export function isPresentationOnlyCommand(command: {
  type: string
  kind?: string
  clearLaunchAgent?: boolean
  viewMode?: string
}): boolean {
  return (
    command.type === 'moveTab' ||
    command.type === 'splitGroup' ||
    command.type === 'setGroupRatios' ||
    (command.type === 'renameTab' && command.kind === 'custom') ||
    (command.type === 'setTabProps' && !command.clearLaunchAgent && command.viewMode === undefined)
  )
}

/** Only explicit presentation edits enter here; no edit can change a source record. */
export type WorkspacePresentationIntent = {
  type: 'layout'
  tabs: readonly Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode | undefined
  activeGroupId: string | undefined
}

export function reduceWorkspacePresentation(
  saved: WorkspacePresentation,
  intent: WorkspacePresentationIntent
): WorkspacePresentation {
  const entities = new Map(saved.tabs.map((tab) => [tab.id, tab.entity]))
  const next: WorkspacePresentation = {
    ...saved,
    tabs: intent.tabs.map((tab) => ({
      ...tabPresentation(tab, saved.anchor.executionHostId ?? saved.anchor.hostId),
      entity:
        entities.get(tab.id) ??
        tabPresentation(tab, saved.anchor.executionHostId ?? saved.anchor.hostId).entity
    })),
    groups: intent.groups.map((group) =>
      group.worktreeId === saved.displayWorkspaceId
        ? group
        : { ...group, worktreeId: saved.displayWorkspaceId }
    ),
    layout: intent.layout,
    activeGroupId: intent.activeGroupId
  }
  noteWorkspacePresentationUserIntent(saved, next)
  return next
}

/** The physical owner supplies its exact locator coverage; sibling sources never move by equivalence. */
export function renameWorkspacePresentations(
  documents: WorkspacePresentationDocuments,
  source: WorkspaceSourceRef,
  nextId: string
): { documents: WorkspacePresentationDocuments; keys: string[] } {
  let next = documents
  const keys: string[] = []
  const moved = (ref: WorkspaceSourceRef): boolean =>
    ref.workspaceId === source.workspaceId && ref.hostId === source.hostId
  const rekey = (ref: WorkspaceSourceRef): WorkspaceSourceRef =>
    moved(ref) ? { ...ref, workspaceId: nextId } : ref
  for (const [key, saved] of Object.entries(documents)) {
    if (!saved || !saved.baseline.some(({ source }) => moved(source))) {
      continue
    }
    const displayWorkspaceId =
      saved.displayWorkspaceId === source.workspaceId ? nextId : saved.displayWorkspaceId
    const groups = (groups: TabGroup[]): TabGroup[] =>
      groups.map((group) =>
        group.worktreeId === source.workspaceId ? { ...group, worktreeId: nextId } : group
      )
    const edited = {
      ...saved,
      anchor: rekey(saved.anchor),
      displayWorkspaceId,
      groups: groups(saved.groups),
      baseline: saved.baseline.map((base) =>
        moved(base.source)
          ? { ...base, source: rekey(base.source), groups: groups(base.groups) }
          : base
      )
    }
    const oldKey = workspacePresentationKey(saved.owner, saved.anchor)
    const newKey = workspacePresentationKey(edited.owner, edited.anchor)
    next = editWorkspacePresentationDocuments(next, oldKey, undefined)
    next = editWorkspacePresentationDocuments(next, newKey, edited)
    keys.push(key, newKey)
  }
  return { documents: next, keys: [...new Set(keys)] }
}

export function restoreWorkspacePresentationGroup(
  original: WorkspacePresentation['layout'],
  current: WorkspacePresentation['layout'],
  groupId: string
): WorkspacePresentation['layout'] {
  const contains = (node: WorkspacePresentation['layout'], id: string): boolean =>
    Boolean(
      node &&
      (node.type === 'leaf'
        ? node.groupId === id
        : contains(node.first, id) || contains(node.second, id))
    )
  if (contains(current, groupId)) {
    return current
  }
  const leaf = { type: 'leaf' as const, groupId }
  if (!current) {
    return leaf
  }
  const parent = (node: WorkspacePresentation['layout']): WorkspacePresentation['layout'] => {
    if (!node || node.type === 'leaf') {
      return undefined
    }
    if (
      (node.first.type === 'leaf' && node.first.groupId === groupId) ||
      (node.second.type === 'leaf' && node.second.groupId === groupId)
    ) {
      return node
    }
    return parent(node.first) ?? parent(node.second)
  }
  const previous = parent(original)
  if (previous?.type === 'split') {
    const sibling =
      previous.first.type === 'leaf' && previous.first.groupId === groupId
        ? previous.second
        : previous.first
    const anchor = (node: typeof sibling): string | undefined =>
      node.type === 'leaf'
        ? contains(current, node.groupId)
          ? node.groupId
          : undefined
        : (anchor(node.first) ?? anchor(node.second))
    const id = anchor(sibling)
    if (id) {
      const insert = (node: NonNullable<typeof current>): NonNullable<typeof current> =>
        node.type === 'leaf'
          ? node.groupId === id
            ? {
                ...previous,
                first:
                  previous.first.type === 'leaf' && previous.first.groupId === groupId
                    ? leaf
                    : node,
                second:
                  previous.first.type === 'leaf' && previous.first.groupId === groupId ? node : leaf
              }
            : node
          : { ...node, first: insert(node.first), second: insert(node.second) }
      return insert(current)
    }
  }
  return { type: 'split', direction: 'horizontal', first: current, second: leaf }
}
