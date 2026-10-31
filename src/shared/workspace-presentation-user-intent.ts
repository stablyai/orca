import type { WorkspacePresentation } from './workspace-presentation'

type IntentReceipt = { touched: Set<string>; release: () => void }
const pending = new WeakMap<WorkspacePresentation['anchor'], Set<IntentReceipt>>()

/** Only in-flight automatic operations retain intent deltas; settlement releases them. */
export function workspacePresentationUserIntent(saved: WorkspacePresentation): IntentReceipt {
  const receipts = pending.get(saved.anchor) ?? new Set<IntentReceipt>()
  const receipt: IntentReceipt = {
    touched: new Set(),
    release: () => {
      receipts.delete(receipt)
    }
  }
  receipts.add(receipt)
  pending.set(saved.anchor, receipts)
  return receipt
}

/** A repeated selection is still a user choice even when its values already match. */
export function noteWorkspacePresentationSelection(
  saved: WorkspacePresentation,
  groupId: string
): void {
  for (const receipt of pending.get(saved.anchor) ?? []) {
    receipt.touched.add('selection')
    receipt.touched.add(`selection:${groupId}`)
  }
}
export function noteWorkspacePresentationUserIntent(
  before: WorkspacePresentation,
  after: WorkspacePresentation
): void {
  const receipts = pending.get(before.anchor)
  if (!receipts?.size) {
    return
  }
  pending.set(after.anchor, receipts)
  const changed = (key: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      for (const receipt of receipts) {
        receipt.touched.add(key)
      }
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
}
export function acceptWorkspacePresentationUserIntent(
  before: WorkspacePresentation,
  reconcile: () => WorkspacePresentation,
  accepted: WorkspacePresentation
): void {
  const receipts = pending.get(before.anchor)
  if (!receipts?.size) {
    return
  }
  const automatic = reconcile()
  pending.set(automatic.anchor, receipts)
  noteWorkspacePresentationUserIntent(automatic, accepted)
}
