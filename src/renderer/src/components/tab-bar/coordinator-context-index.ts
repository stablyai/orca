import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { readRecordChanges } from '@/store/record-transitions/keyed-record-change-reads'
import type { AgentStatusProjection } from '@/store/slices/agent-status/projection/agent-status-projection'
import type {
  CoordinatorTabIdentityIndex,
  IndexedCoordinatorTab
} from './coordinator-tab-identities'

type PaneContext = {
  context: AgentStatusOrchestrationContext
  tabId: string | undefined
  order: number
}

export class CoordinatorContextIndex<T> {
  private source: Record<string, T> | undefined
  private mapProjection: AgentStatusProjection | undefined
  private mapCursor = 0
  private readonly panes = new Map<string, PaneContext>()
  private readonly byTab = new Map<string, Set<PaneContext>>()

  constructor(
    private readonly contextOf: (
      value: T | undefined
    ) => AgentStatusOrchestrationContext | undefined
  ) {}

  updateMap(
    source: ReadonlyMap<string, T>,
    projection: AgentStatusProjection,
    changed: (tabId: string, valueChanged: boolean) => void
  ): void {
    const cursor = projection.changeCursor()
    if (this.mapProjection === projection && this.mapCursor === cursor) {
      return
    }
    const keys = this.mapProjection === projection ? projection.changesSince(this.mapCursor) : null
    let existingOnly = keys !== null
    for (const key of keys ?? []) {
      if (this.contextOf(source.get(key)) && !this.panes.has(key)) {
        existingOnly = false
        break
      }
    }
    if (existingOnly && keys) {
      for (const key of keys) {
        const pane = this.panes.get(key),
          context = this.contextOf(source.get(key))
        if (pane && !context) {
          this.remove(key, pane, changed)
        } else if (pane && context && pane.context !== context) {
          pane.context = context
          if (pane.tabId) {
            changed(pane.tabId, true)
          }
        }
      }
    } else {
      let order = 0
      for (const [key, value] of source) {
        const context = this.contextOf(value),
          pane = this.panes.get(key)
        if (!context) {
          if (pane) {
            this.remove(key, pane, changed)
          }
          continue
        }
        if (pane) {
          if (pane.context !== context || pane.order !== order) {
            const valueChanged = pane.context !== context
            pane.context = context
            pane.order = order
            if (pane.tabId) {
              changed(pane.tabId, valueChanged)
            }
          }
        } else {
          const next = { context, tabId: parsePaneKey(key)?.tabId, order }
          this.panes.set(key, next)
          if (next.tabId) {
            let entries = this.byTab.get(next.tabId)
            if (!entries) {
              entries = new Set()
              this.byTab.set(next.tabId, entries)
            }
            entries.add(next)
            changed(next.tabId, true)
          }
        }
        order++
      }
      if (order !== this.panes.size) {
        for (const [key, pane] of this.panes) {
          if (!this.contextOf(source.get(key))) {
            this.remove(key, pane, changed)
          }
        }
      }
    }
    this.mapProjection = projection
    this.mapCursor = cursor
  }

  update(source: Record<string, T>, changed: (tabId: string, valueChanged: boolean) => void): void {
    if (this.source === source) {
      return
    }
    const changes = this.source && readRecordChanges(source, this.source)
    if (changes?.kind === 'addressed') {
      let existingOnly = true
      for (const key of changes.keys) {
        if (!this.panes.has(key) || !this.contextOf(source[key])) {
          existingOnly = false
          break
        }
      }
      if (existingOnly) {
        for (const key of changes.keys) {
          const pane = this.panes.get(key)!
          const context = this.contextOf(source[key])!
          if (pane.context !== context) {
            pane.context = context
            if (pane.tabId) {
              changed(pane.tabId, true)
            }
          }
        }
        this.source = source
        return
      }
    }
    let count = 0
    for (const key in source) {
      const context = this.contextOf(source[key])
      const previous = this.panes.get(key)
      if (!context) {
        if (previous) {
          this.remove(key, previous, changed)
        }
        continue
      }
      const order = count++
      if (!previous) {
        const pane = { context, tabId: parsePaneKey(key)?.tabId, order }
        this.panes.set(key, pane)
        if (pane.tabId) {
          let entries = this.byTab.get(pane.tabId)
          if (!entries) {
            entries = new Set()
            this.byTab.set(pane.tabId, entries)
          }
          entries.add(pane)
          changed(pane.tabId, true)
        }
      } else if (previous.context !== context || previous.order !== order) {
        const valueChanged = previous.context !== context
        previous.context = context
        previous.order = order
        if (previous.tabId) {
          changed(previous.tabId, valueChanged)
        }
      }
    }
    if (count !== this.panes.size) {
      for (const [key, pane] of this.panes) {
        if (!this.contextOf(source[key])) {
          this.remove(key, pane, changed)
        }
      }
    }
    this.source = source
  }

  first(
    entry: IndexedCoordinatorTab,
    identities: CoordinatorTabIdentityIndex
  ): AgentStatusOrchestrationContext | undefined {
    let first = this.firstIn(this.byTab.get(entry.tab.id), entry, identities)
    if (entry.tab.entityId !== entry.tab.id) {
      first = this.firstIn(this.byTab.get(entry.tab.entityId), entry, identities, first)
    }
    return first?.context
  }

  private firstIn(
    panes: ReadonlySet<PaneContext> | undefined,
    entry: IndexedCoordinatorTab,
    identities: CoordinatorTabIdentityIndex,
    first?: PaneContext
  ): PaneContext | undefined {
    if (panes) {
      for (const pane of panes) {
        if (
          pane.context.coordinatorIdentity &&
          pane.tabId &&
          identities.byAlias(pane.tabId) === entry &&
          (!first || pane.order < first.order)
        ) {
          first = pane
        }
      }
    }
    return first
  }

  private remove(
    key: string,
    pane: PaneContext,
    changed: (tabId: string, valueChanged: boolean) => void
  ): void {
    this.panes.delete(key)
    if (pane.tabId) {
      const entries = this.byTab.get(pane.tabId)
      entries?.delete(pane)
      if (!entries?.size) {
        this.byTab.delete(pane.tabId)
      }
      changed(pane.tabId, true)
    }
  }
}
