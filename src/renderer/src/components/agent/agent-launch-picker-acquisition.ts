import {
  agentPickerCatalogJobs,
  updateAgentPickerCatalog,
  agentPickerSourceView,
  type AgentPickerCatalogJob
} from './agent-picker-catalog-jobs'
export {
  createAgentPickerInventorySource,
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from './agent-picker-inventory-source'
import { modelCatalogSource } from '../../../../shared/agent-session/options/model-catalog-source'
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
  private jobs: AgentPickerCatalogJob[]
  private defaults: AgentPickerEntry[]
  private catalogSubscriptions: (() => void)[] = []

  constructor(
    readonly key: string,
    private initial: AgentPickerEntry[],
    private reads: Reads
  ) {
    this.entries = initial
    this.jobs = agentPickerCatalogJobs(initial)
    for (const job of this.jobs) {
      this.entries = updateAgentPickerCatalog(this.entries, job, { catalogRead: 'pending' })
    }
    this.defaults = initial
    for (const [i, entry] of initial.entries()) {
      if (entry.structuredDefaultsPending) {
        this.supports.set(i, { state: 'queued' })
      }
    }
    this.queued = {
      catalog: new Set(this.jobs.map((_, index) => index)),
      support: new Set(this.supports.keys())
    }
  }

  observe(observer: Observer) {
    const first = this.observers.size === 0
    this.observers.add(observer)
    if (first) {
      this.catalogSubscriptions = this.jobs.map(
        (job, index) =>
          this.reads.observeCatalog?.(
            this.entries[job.index],
            ({ answer, pending, invalidated }) => {
              this.entries = updateAgentPickerCatalog(this.entries, job, {
                catalog: answer ?? { origin: 'unknown' },
                catalogRead: pending || invalidated ? 'pending' : 'settled'
              })
              if (invalidated) {
                this.queued.catalog.add(index)
              }
              this.publish()
              this.admit('catalog')
            },
            job.source
          ) ?? (() => {})
      )
      for (const [index, job] of this.jobs.entries()) {
        const view = agentPickerSourceView(this.entries[job.index], job.source)
        if (
          view.catalogRead !== 'pending' &&
          (this.deferredCatalogs.has(index) ||
            view.catalog.origin === 'unknown' ||
            view.catalogRead === 'failed' ||
            view.catalog.unavailable !== undefined ||
            view.catalog.listingInProgress)
        ) {
          this.queued.catalog.add(index)
          this.entries = updateAgentPickerCatalog(this.entries, job, { catalogRead: 'pending' })
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
    const stopDemand = observer.subscribeDemand?.(() => this.admit('catalog'))
    observer.publish(this.entries)
    this.admit('catalog')
    this.admit('support')
    return () => {
      stopDemand?.()
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
        ...(this.entries[i].sourceCatalogs
          ? { sourceCatalogs: this.entries[i].sourceCatalogs }
          : {}),
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
    const job = this.jobs[index]
    const saved = await this.reads.catalog(entry, false, job.source)
    if (!saved?.listingInProgress) {
      return saved
    }
    if (saved.origin !== 'unknown') {
      this.entries = updateAgentPickerCatalog(this.entries, job, { catalog: saved })
      this.publish()
    }
    if (!this.observers.size) {
      this.deferredCatalogs.add(index)
      return saved
    }
    return this.reads.catalog(entry, true, job.source)
  }

  private admit(kind: 'catalog' | 'support') {
    while (this.observers.size && this.outstanding[kind] < 2 && this.queued[kind].size) {
      const usable = [...this.queued[kind]].filter((index) => {
        if (kind !== 'catalog') {
          return true
        }
        const job = this.jobs[index],
          entry = this.entries[job.index]
        return [...this.observers].some(
          (observer) =>
            observer.usesSource?.(entry, job.source) ??
            (job.source !== 'cli' ||
              modelCatalogSource(entry.agent, entry.defaultSurface) === job.source)
        )
      })
      if (!usable.length) {
        break
      }
      const priorities = [...this.observers].map((o) => o.selected())
      const index =
        usable.find((index) =>
          priorities.includes(
            this.entries[kind === 'catalog' ? this.jobs[index].index : index].agent
          )
        ) ?? usable[0]
      if (index === undefined) {
        break
      }
      this.queued[kind].delete(index)
      this.outstanding[kind]++
      const entry = this.entries[kind === 'catalog' ? this.jobs[index].index : index]
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
                this.entries = updateAgentPickerCatalog(this.entries, this.jobs[index], {
                  ...(catalog ? { catalog } : {}),
                  catalogRead: resume ? 'pending' : 'settled'
                })
              })
              .catch((error: unknown) => {
                const unsupported =
                  typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  (error.code === 'method_not_found' ||
                    error.code === 'structured_agent_session_unsupported' ||
                    error.code === 'forbidden')
                this.entries = updateAgentPickerCatalog(this.entries, this.jobs[index], {
                  catalogRead: unsupported ? 'unsupported' : 'failed'
                })
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
