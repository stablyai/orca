import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { CarriedSessionFields } from './workspace-layout-beside'
import { RetiringGroupLayout } from './workspace-layout-retiring-group-layout'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import {
  paneKeyOf,
  type LayoutGroup,
  type LayoutTerminalTab,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'

class RetiringPanes {
  private readonly present = new Set<string>()
  private readonly removed = new Set<string>()
  private readonly remaining: (() => TerminalPaneLayoutNode | null)[]

  constructor(private readonly root: TerminalPaneLayoutNode | null) {
    this.remaining = [() => root]
  }

  private walk(node: TerminalPaneLayoutNode | null, stop?: string): boolean {
    if (!node) {
      return false
    }
    if (node.type === 'leaf') {
      const leafId = node.leafId
      this.present.add(leafId)
      return stop !== undefined && leafId === stop
    }
    this.remaining.push(() => node.second)
    if (this.walk(node.first, stop)) {
      return true
    }
    return this.walk(this.remaining.pop()!(), stop)
  }

  contains(leafId: string): boolean {
    if (this.removed.has(leafId)) {
      return false
    }
    if (this.present.has(leafId)) {
      return true
    }
    while (this.remaining.length > 0) {
      if (this.walk(this.remaining.pop()!(), leafId)) {
        return true
      }
    }
    return false
  }

  remove(leafId: string): boolean {
    // Removal visits the complete tree only after presence and replacement have been decided.
    while (this.remaining.length > 0) {
      this.walk(this.remaining.pop()!())
    }
    this.present.delete(leafId)
    this.removed.add(leafId)
    return this.present.size === 0
  }

  materialize(): TerminalPaneLayoutNode | null {
    const prune = (node: TerminalPaneLayoutNode | null): TerminalPaneLayoutNode | null => {
      if (!node || node.type === 'leaf') {
        return node && this.removed.has(node.leafId) ? null : node
      }
      const originalFirst = node.first
      const first = prune(originalFirst)
      const originalSecond = node.second
      const second = prune(originalSecond)
      if (!first || !second) {
        return first ?? second
      }
      return first === originalFirst && second === originalSecond
        ? node
        : { ...node, first, second }
    }
    return prune(this.root)
  }
}

type GroupState = { original: LayoutGroup; remaining: number; removed: Set<string> }
type Cohort = {
  dead: boolean
  template?: LayoutTerminalTab
  panes?: RetiringPanes
  chatRemoved: boolean
}
type TerminalSlot = {
  workspace: RetiringWorkspace
  cohort: Cohort
  tab: LayoutTerminalTab
  panes?: RetiringPanes
}

class RetiringWorkspace {
  readonly cohorts = new Map<string, Cohort>()
  private changed = false
  private closed = false
  private leaves: WorkspaceLayout['leaves']
  private ownedLeaves = false
  private groups?: GroupState[]
  private memberships?: Map<string, GroupState[]>
  private groupLayout?: RetiringGroupLayout

  constructor(readonly original: WorkspaceLayout) {
    this.leaves = original.leaves
  }

  leaf(leafId: string) {
    return this.leaves?.[leafId]
  }

  retire(slot: TerminalSlot, leafId: string, panes: RetiringPanes): void {
    const empty = panes.remove(leafId)
    this.changed = true
    if (empty) {
      slot.cohort.dead = true
      this.close(slot.tab.id)
    } else {
      slot.cohort.template ??= slot.tab
      slot.cohort.panes = panes
      if (slot.cohort.template.panes.chatLeafId === leafId) {
        slot.cohort.chatRemoved = true
      }
    }
    if (this.leaves && Object.hasOwn(this.leaves, leafId)) {
      if (!this.ownedLeaves) {
        this.leaves = { ...this.leaves }
        this.ownedLeaves = true
      }
      delete this.leaves[leafId]
    }
  }

  private close(tabId: string): void {
    this.closed = true
    if (!this.groups) {
      this.groups = []
      this.memberships = new Map()
      for (const original of this.original.groups) {
        const group = { original, remaining: original.tabOrder.length, removed: new Set<string>() }
        this.groups.push(group)
        for (const member of original.tabOrder) {
          const entries = this.memberships.get(member) ?? []
          entries.push(group)
          this.memberships.set(member, entries)
        }
      }
    }
    for (const group of this.memberships!.get(tabId) ?? []) {
      group.removed.add(tabId)
      group.remaining--
      if (group.remaining === 0 && this.original.groupLayout) {
        this.groupLayout ??= new RetiringGroupLayout(this.original.groupLayout)
        this.groupLayout.remove(group.original.id)
      }
    }
  }

  materialize(): WorkspaceLayout {
    if (!this.changed) {
      return this.original
    }
    const panesByCohort = new Map<Cohort, LayoutTerminalTab['panes']>()
    const tabs = this.original.tabs.flatMap((tab) => {
      const cohort = this.cohorts.get(tab.id)!
      if (cohort.dead) {
        return []
      }
      if (!cohort.template) {
        return [tab]
      }
      let panes = panesByCohort.get(cohort)
      if (!panes) {
        panes = { ...cohort.template.panes, root: cohort.panes!.materialize() }
        if (cohort.chatRemoved) {
          delete panes.chatLeafId
        }
        panesByCohort.set(cohort, panes)
      }
      return [{ ...cohort.template, panes }]
    })
    const next: WorkspaceLayout = { ...this.original, tabs, leaves: this.leaves }
    if (this.closed) {
      next.groups = this.groups!.flatMap(({ original, remaining, removed }) =>
        removed.size === 0
          ? [original]
          : remaining === 0
            ? []
            : [{ ...original, tabOrder: original.tabOrder.filter((id) => !removed.has(id)) }]
      )
      const groupLayout = this.groupLayout
        ? this.groupLayout.materialize()
        : this.original.groupLayout
      if (groupLayout) {
        next.groupLayout = groupLayout
      } else {
        delete next.groupLayout
      }
    }
    return next
  }
}

/** Loader-private phase: no intermediate model escapes before the final legacy comparison. */
export function retireLoadedLegacySurfaces(
  model: WorkspaceLayoutModel,
  session: WorkspaceSessionState,
  carried: CarriedSessionFields
): WorkspaceLayoutModel {
  const tombstones = Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})
  if (tombstones.length === 0) {
    return updateLegacyPersistence(model, model, [])
  }
  const workspaces = new Map<string, RetiringWorkspace>()
  const entities = new Map<string, { slots: TerminalSlot[]; cursor: number }>()
  for (const [key, original] of Object.entries(model.workspaces)) {
    const workspace = new RetiringWorkspace(original)
    workspaces.set(key, workspace)
    for (const tab of original.tabs) {
      let cohort = workspace.cohorts.get(tab.id)
      if (!cohort) {
        cohort = { dead: false, chatRemoved: false }
        workspace.cohorts.set(tab.id, cohort)
      }
      if (tab.kind === 'terminal') {
        const entity: { slots: TerminalSlot[]; cursor: number } = entities.get(tab.entityId) ?? {
          slots: [],
          cursor: 0
        }
        entity.slots.push({ workspace, cohort, tab })
        entities.set(tab.entityId, entity)
      }
    }
  }
  for (const surface of tombstones) {
    const entity = entities.get(surface.parentTabId)
    let slot: TerminalSlot | undefined
    if (entity) {
      while (entity.cursor < entity.slots.length) {
        const candidate = entity.slots[entity.cursor]
        if (
          !candidate.cohort.dead &&
          (!candidate.cohort.template || candidate.cohort.template.entityId === surface.parentTabId)
        ) {
          slot = candidate
          break
        }
        entity.cursor++
      }
    }
    const tab = slot?.cohort.template ?? slot?.tab
    const panes = slot && (slot.cohort.panes ?? (slot.panes ??= new RetiringPanes(tab!.panes.root)))
    if (!slot || !panes?.contains(surface.leafId)) {
      delete carried.unplacedIncarnations[paneKeyOf(surface.parentTabId, surface.leafId)]
      continue
    }
    const leaf = slot.workspace.leaf(surface.leafId)
    if (
      (surface.incarnationId &&
        leaf?.incarnationId &&
        leaf.incarnationId !== surface.incarnationId) ||
      (leaf?.ptyId && leaf.ptyId !== surface.ptyId)
    ) {
      continue
    }
    slot.workspace.retire(slot, surface.leafId, panes)
  }
  let next = model
  for (const [key, workspace] of workspaces) {
    const value = workspace.materialize()
    if (value !== workspace.original) {
      if (next === model) {
        next = { ...model, workspaces: { ...model.workspaces } }
      }
      Object.defineProperty(next.workspaces, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
  }
  return updateLegacyPersistence(
    model,
    next,
    tombstones.map((surface) => surface.worktreeId)
  )
}
