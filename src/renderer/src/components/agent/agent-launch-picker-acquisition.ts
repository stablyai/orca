import {
  agentPickerCatalogJobs,
  invalidateAgentPickerCatalogJobs,
  prepareAgentPickerCatalogDemand,
  agentPickerCatalogFailure,
  updateAgentPickerCatalog,
  type AgentPickerCatalogJob
} from './agent-picker-catalog-jobs'
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
type ReadKind = 'catalog' | 'refresh' | 'support'
type SupportRead = {
  state: 'queued' | 'pending' | 'settled'
  value?: AgentPickerEntry['structured']
}

class AgentPickerAcquisition {
  readonly observers = new Set<Observer>()
  entries: AgentPickerEntry[]
  settingsPending = false
  private demand?: AbortController
  private outstanding = { catalog: 0, refresh: 0, support: 0 }
  private queued: Record<ReadKind, Set<number>>
  private supports = new Map<number, SupportRead>()
  private jobs: AgentPickerCatalogJob[]
  private defaults: AgentPickerEntry[]
  private stopInvalidation?: () => void
  private physicalCatalogs = 0

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
      refresh: new Set(),
      support: new Set(this.supports.keys())
    }
  }

  observe(observer: Observer) {
    const first = this.observers.size === 0
    this.observers.add(observer)
    if (first) {
      if (this.demand) {
        this.jobs = this.jobs.map((job) =>
          job.surface === 'terminal' && job.pending ? job : { ...job }
        )
      }
      this.demand = new AbortController()
      this.outstanding = { catalog: 0, refresh: 0, support: this.outstanding.support }
      this.stopInvalidation = this.reads.subscribeInvalidation?.(() => {
        this.outstanding = { catalog: 0, refresh: 0, support: this.outstanding.support }
        const invalidated = invalidateAgentPickerCatalogJobs({
          entries: this.entries,
          jobs: this.jobs,
          refreshOnInvalidation: this.reads.refreshOnInvalidation,
          queued: this.queued
        })
        this.entries = invalidated.entries
        this.jobs = invalidated.jobs
        this.publish()
        this.admit('catalog')
      })
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
    this.entries = prepareAgentPickerCatalogDemand(this.entries, this.jobs, this.queued.catalog)
    observer.publish(this.entries)
    this.admit('catalog')
    this.admit('refresh')
    this.admit('support')
    return () => {
      this.observers.delete(observer)
      if (!this.observers.size) {
        this.demand?.abort()
        this.stopInvalidation?.()
        this.stopInvalidation = undefined
        this.queued.refresh.clear()
        this.jobs.forEach((job, index) => {
          if (job.surface !== 'terminal' || !job.pending) {
            this.queued.catalog.add(index)
          }
        })
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
        ...(this.entries[i].terminalCatalogRead
          ? {
              terminalCatalog: this.entries[i].terminalCatalog,
              terminalCatalogRead: this.entries[i].terminalCatalogRead
            }
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

  private async readCatalog(entry: AgentPickerEntry, index: number, waitForListing: boolean) {
    const job = this.jobs[index]
    const signal = this.demand!.signal
    const catalog = await this.reads.catalog(entry, waitForListing, signal, job.surface)
    if (
      job !== this.jobs[index] ||
      (signal.aborted && job.surface !== 'terminal' && this.observers.size > 0) ||
      !catalog
    ) {
      return
    }
    // An open picker waits on a running listing, and again when a wait used its whole budget.
    const refresh =
      !signal.aborted &&
      this.observers.size > 0 &&
      (waitForListing ? catalog.waitExpired : catalog.listingInProgress) === true
    if (refresh) {
      this.queued.refresh.add(index)
    }
    this.entries = updateAgentPickerCatalog(this.entries, job, {
      catalog,
      catalogRead: refresh ? 'pending' : 'settled'
    })
  }

  private admit(kind: ReadKind) {
    while (this.observers.size && this.outstanding[kind] < 2 && this.queued[kind].size) {
      const usable = [...this.queued[kind]]
      const priorities = [...this.observers].map((o) => o.selected())
      const index =
        usable.find((index) =>
          priorities.includes(
            this.entries[kind !== 'support' ? this.jobs[index].index : index].agent
          )
        ) ?? usable[0]
      if (index === undefined) {
        break
      }
      this.queued[kind].delete(index)
      const outstanding = this.outstanding
      outstanding[kind]++
      const entry = this.entries[kind !== 'support' ? this.jobs[index].index : index]
      if (kind === 'support') {
        this.supports.set(index, { state: 'pending' })
      } else {
        this.physicalCatalogs++
      }
      const job = this.jobs[index]
      const signal = this.demand!.signal
      if (kind !== 'support' && job.surface === 'terminal') {
        job.pending = true
      }
      const read =
        kind !== 'support'
          ? this.readCatalog(entry, index, kind === 'refresh').catch((error: unknown) => {
              if (job === this.jobs[index] && (!signal.aborted || job.surface === 'terminal')) {
                this.entries = updateAgentPickerCatalog(this.entries, job, {
                  catalogRead: agentPickerCatalogFailure(error)
                })
              }
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
          if (kind === 'support') {
            this.outstanding.support--
          } else {
            outstanding[kind]--
            this.physicalCatalogs--
            job.pending = false
          }
          this.publish()
          this.admit(kind)
          if (kind !== 'support') {
            this.admit(kind === 'catalog' ? 'refresh' : 'catalog')
          }
          this.retire()
        })
    }
  }

  private retire() {
    if (
      !this.observers.size &&
      !this.settingsPending &&
      !this.physicalCatalogs &&
      !this.outstanding.support
    ) {
      if (pending.get(this.key) === this) {
        pending.delete(this.key)
      }
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
