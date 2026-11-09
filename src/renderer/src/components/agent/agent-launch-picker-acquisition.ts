export {
  createAgentPickerInventorySource,
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from './agent-picker-inventory-source'
import { shallow } from 'zustand/shallow'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type {
  AgentPickerAcquisitionObserver as Observer,
  AgentPickerAcquisitionReads as Reads
} from './agent-picker-inventory-source'

/** Pending local IPC outlives observers; matching menus must retain its physical owner. */
const pending = new Map<string, AgentPickerAcquisition>()
type SupportRead = {
  state: 'queued' | 'pending' | 'settled'
  value?: AgentPickerEntry['structured']
}

class AgentPickerAcquisition {
  readonly observers = new Set<Observer>()
  entries: AgentPickerEntry[]
  settingsPending = false
  private outstanding = { catalog: 0, support: 0 }
  private queued: Record<'catalog' | 'support', Set<number>>
  private deferredCatalogs = new Set<number>()
  private supports = new Map<number, SupportRead>()
  private defaults: AgentPickerEntry[]
  private catalogSubscriptions: (() => void)[] = []

  constructor(
    readonly key: string,
    private initial: AgentPickerEntry[],
    private reads: Reads
  ) {
    this.entries = initial.map((entry) => ({
      ...entry,
      catalogRead:
        entry.surfaces.length && entry.catalogRead !== 'unsupported' ? 'pending' : 'unsupported'
    }))
    this.defaults = initial
    for (const [i, entry] of initial.entries()) {
      if (entry.structuredDefaultsPending) {
        this.supports.set(i, { state: 'queued' })
      }
    }
    this.queued = {
      catalog: new Set(
        this.entries.flatMap((entry, i) => (entry.catalogRead === 'pending' ? [i] : []))
      ),
      support: new Set(this.supports.keys())
    }
  }

  observe(observer: Observer) {
    const first = this.observers.size === 0
    this.observers.add(observer)
    if (first) {
      this.catalogSubscriptions = this.entries.map(
        (entry, index) =>
          this.reads.observeCatalog?.(entry, ({ answer, pending, invalidated }) => {
            this.entries = this.entries.map((row, i) =>
              i === index
                ? {
                    ...row,
                    catalog: answer ?? { origin: 'unknown' },
                    catalogRead: pending || invalidated ? 'pending' : 'settled'
                  }
                : row
            )
            if (invalidated) {
              this.queued.catalog.add(index)
            }
            this.publish()
            this.admit('catalog')
          }) ?? (() => {})
      )
      for (const [i, entry] of this.entries.entries()) {
        if (
          this.initial[i].catalogRead !== 'unsupported' &&
          entry.surfaces.length &&
          entry.catalogRead !== 'pending' &&
          (this.deferredCatalogs.has(i) ||
            entry.catalog.origin === 'unknown' ||
            entry.catalogRead === 'failed' ||
            entry.catalogRead === 'unsupported' ||
            entry.catalog.unavailable !== undefined ||
            entry.catalog.listingInProgress)
        ) {
          this.queued.catalog.add(i)
          this.entries[i] = { ...entry, catalogRead: 'pending' }
        }
      }
      for (const [i, read] of this.supports) {
        if (read.state === 'settled') {
          this.supports.set(i, { state: 'queued' })
          this.queued.support.add(i)
        }
      }
      if (!this.settingsPending && this.reads.settings) {
        this.defaults = this.initial
        this.readSettings(this.reads.settings)
      }
      this.entries = this.project()
    }
    observer.publish(this.entries)
    this.admit('catalog')
    this.admit('support')
    return () => {
      this.observers.delete(observer)
      if (!this.observers.size) {
        this.catalogSubscriptions.forEach((stop) => stop())
        this.catalogSubscriptions = []
      }
      this.retire()
    }
  }

  private publish() {
    for (const observer of this.observers) {
      observer.publish(this.entries)
    }
  }

  private project(reopen = false) {
    const defaults =
      reopen && this.reads.settings && !this.settingsPending ? this.initial : this.defaults
    return defaults.map((entry, i) => {
      const read = this.supports.get(i)
      const current = read && !(reopen && read.state === 'settled')
      const next = {
        ...entry,
        catalog: this.entries[i].catalog,
        catalogRead: this.entries[i].catalogRead,
        ...(read
          ? {
              structured: (current && read.value) || entry.structured,
              structuredDefaultsPending:
                !current ||
                read.state !== 'settled' ||
                (!read.value && entry.structuredDefaultsPending !== false)
            }
          : {})
      }
      return shallow(this.entries[i], next) ? this.entries[i] : next
    })
  }

  currentEntries() {
    // Pending sibling I/O owns its request, never renewed authority for completed defaults.
    return this.observers.size ? this.entries : this.project(true)
  }

  private readSettings(read: NonNullable<Reads['settings']>) {
    this.settingsPending = true
    void read()
      .catch(() => undefined)
      .then((entries) => {
        if (entries) {
          this.defaults = entries
        }
        this.settingsPending = false
        this.entries = this.project()
        this.publish()
        this.retire()
      })
  }

  private async readCatalog(entry: AgentPickerEntry, index: number) {
    this.deferredCatalogs.delete(index)
    const saved = await this.reads.catalog(entry, false)
    if (!saved?.listingInProgress) {
      return saved
    }
    if (saved.origin !== 'unknown') {
      this.entries = this.entries.map((e, i) => (i === index ? { ...e, catalog: saved } : e))
      this.publish()
    }
    if (!this.observers.size) {
      this.deferredCatalogs.add(index)
      return saved
    }
    return this.reads.catalog(entry, true)
  }

  private admit(kind: 'catalog' | 'support') {
    while (this.observers.size && this.outstanding[kind] < 2 && this.queued[kind].size) {
      const priorities = [...this.observers].map((o) => o.selected())
      const preferred = this.entries.findIndex((e) => priorities.includes(e.agent))
      const index = this.queued[kind].has(preferred)
        ? preferred
        : this.queued[kind].values().next().value
      if (index === undefined) {
        break
      }
      this.queued[kind].delete(index)
      this.outstanding[kind]++
      const entry = this.entries[index]
      if (kind === 'support') {
        this.supports.set(index, { state: 'pending' })
      }
      const read =
        kind === 'catalog'
          ? this.readCatalog(entry, index)
              .then((catalog) => {
                const resume = this.deferredCatalogs.has(index) && this.observers.size > 0
                if (resume) {
                  this.queued.catalog.add(index)
                }
                this.entries = this.entries.map((e, i) =>
                  i === index
                    ? {
                        ...e,
                        ...(catalog ? { catalog } : {}),
                        catalogRead: resume ? 'pending' : 'settled'
                      }
                    : e
                )
              })
              .catch((error: unknown) => {
                const unsupported =
                  typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  (error.code === 'method_not_found' ||
                    error.code === 'structured_agent_session_unsupported' ||
                    error.code === 'forbidden')
                this.entries = this.entries.map((e, i) =>
                  i === index
                    ? {
                        ...e,
                        catalogRead: unsupported ? 'unsupported' : 'failed'
                      }
                    : e
                )
              })
          : this.reads
              .support(entry)
              .catch(() => undefined)
              .then((value) => {
                this.supports.set(index, { state: 'settled', value })
                this.entries = this.project()
              })
      void read
        .catch(() => undefined)
        .then(() => {
          this.outstanding[kind]--
          this.publish()
          this.admit(kind)
          this.retire()
        })
    }
  }

  private retire() {
    if (
      !this.observers.size &&
      !this.settingsPending &&
      !this.outstanding.catalog &&
      !this.outstanding.support
    ) {
      pending.delete(this.key)
    }
  }

  diagnostics() {
    return {
      observers: this.observers.size,
      settings: Number(this.settingsPending),
      ...this.outstanding
    }
  }
}

export function observeAgentPickerAcquisition(
  key: string,
  entries: AgentPickerEntry[],
  reads: Reads,
  observer: Observer
) {
  let resource = pending.get(key)
  if (!resource) {
    resource = new AgentPickerAcquisition(key, entries, reads)
    pending.set(key, resource)
  }
  return resource.observe(observer)
}

export function currentAgentPickerAcquisition(key: string) {
  const resource = pending.get(key)
  return resource?.currentEntries()
}

export function agentPickerAcquisitionDiagnostics() {
  return [...pending.values()].map((resource) => ({ key: resource.key, ...resource.diagnostics() }))
}
