import type { WorkspacePresentation } from './workspace-presentation'

type Topology = Pick<WorkspacePresentation, 'groups' | 'layout' | 'activeGroupId'>
type IntentReceipt = { touched: Set<string>; topology: Topology; release: () => void }
type Pending = {
  receipts: Set<IntentReceipt>
  topology: Topology
  anchors: Set<WorkspacePresentation['anchor']>
}
const pending = new WeakMap<WorkspacePresentation['anchor'], Pending>()
const publications = new WeakMap<WorkspacePresentation, Set<string>>()

/** Only in-flight automatic operations retain intent deltas; settlement releases them. */
export function workspacePresentationUserIntent(saved: WorkspacePresentation): IntentReceipt {
  const context = pending.get(saved.anchor) ?? {
    receipts: new Set<IntentReceipt>(),
    anchors: new Set([saved.anchor]),
    topology: { groups: saved.groups, layout: saved.layout, activeGroupId: saved.activeGroupId }
  }
  const receipt: IntentReceipt = {
    touched: new Set(),
    topology: context.topology,
    release: () => {
      context.receipts.delete(receipt)
      if (!context.receipts.size) {
        for (const anchor of context.anchors) {
          if (pending.get(anchor) === context) {
            pending.delete(anchor)
          }
        }
        context.anchors.clear()
      }
    }
  }
  context.receipts.add(receipt)
  pending.set(saved.anchor, context)
  return receipt
}

/** A repeated selection is still a user choice even when its values already match. */
export function noteWorkspacePresentationSelection(
  saved: WorkspacePresentation,
  groupId: string
): void {
  recordWorkspacePresentationIntent(saved, ['selection', `selection:${groupId}`], {
    ...saved,
    activeGroupId: groupId
  })
}
/** Called only by an accepted intent producer, including semantic baseline reconciliation. */
export function recordWorkspacePresentationIntent(
  before: WorkspacePresentation,
  keys: Iterable<string>,
  after: WorkspacePresentation
): void {
  if (before.owner !== 'main' && !pending.get(before.anchor)?.receipts.size) {
    return
  }
  const fields = new Set(keys)
  if (!fields.size) {
    return
  }
  publications.set(after, new Set([...(publications.get(after) ?? []), ...fields]))
  const context = pending.get(before.anchor)
  if (!context) {
    return
  }
  for (const receipt of context.receipts) {
    for (const key of fields) {
      receipt.touched.add(key)
    }
  }
  context.topology = {
    layout: fields.has('layout') ? after.layout : context.topology.layout,
    activeGroupId: fields.has('selection') ? after.activeGroupId : context.topology.activeGroupId,
    groups: fields.has('layout')
      ? after.groups
      : context.topology.groups.map((group) => {
          const current = after.groups.find((entry) => entry.id === group.id)
          return current
            ? {
                ...group,
                tabOrder: fields.has(`order:${group.id}`) ? current.tabOrder : group.tabOrder,
                activeTabId: fields.has(`selection:${group.id}`)
                  ? current.activeTabId
                  : group.activeTabId
              }
            : group
        })
  }
  context.anchors.add(after.anchor)
  pending.set(after.anchor, context)
}

/** Transient same-build owner publication metadata; never part of the saved document or peer codec. */
export function workspacePresentationIntentFields(saved: WorkspacePresentation): string[] {
  const fields = [...(publications.get(saved) ?? [])]
  publications.delete(saved)
  return fields
}
export function noteWorkspacePresentationUserIntent(
  before: WorkspacePresentation,
  after: WorkspacePresentation
): void {
  if (before.owner !== 'main' && !pending.get(before.anchor)?.receipts.size) {
    return
  }
  const fields = new Set<string>()
  const changed = (key: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      fields.add(key)
    }
  }
  const tabs = new Map(before.tabs.map((tab) => [tab.id, tab]))
  const nextTabs = new Map(after.tabs.map((tab) => [tab.id, tab]))
  for (const id of new Set([...tabs.keys(), ...nextTabs.keys()])) {
    const tab = nextTabs.get(id),
      old = tabs.get(id)
    for (const field of [
      'groupId',
      'customLabel',
      'color',
      'isPinned',
      'viewMode',
      'lastFocusedAt'
    ] as const) {
      changed(`tab:${id}:${field}`, old?.[field], tab?.[field])
    }
  }
  changed('layout', before.layout, after.layout)
  changed('selection', before.activeGroupId, after.activeGroupId)
  const groups = new Map(before.groups.map((group) => [group.id, group]))
  const nextGroups = new Map(after.groups.map((group) => [group.id, group]))
  for (const id of new Set([...groups.keys(), ...nextGroups.keys()])) {
    const group = nextGroups.get(id),
      old = groups.get(id)
    changed(`order:${id}`, old?.tabOrder, group?.tabOrder)
    changed(`selection:${id}`, old?.activeTabId, group?.activeTabId)
  }
  recordWorkspacePresentationIntent(before, fields, after)
}
