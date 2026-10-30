import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Pending local IPC outlives observers; matching menus must retain its physical owner. */
const pending = new Map<string, AgentPickerAcquisition>()
type Observer = {
  publish: (entries: AgentPickerEntry[]) => void
  selected: () => TuiAgent | undefined
}
type Reads = {
  settings?: () => Promise<AgentPickerEntry[] | undefined>
  catalog: (entry: AgentPickerEntry) => Promise<AgentPickerEntry['catalog'] | undefined>
  support: (entry: AgentPickerEntry) => Promise<AgentPickerEntry['structured'] | undefined>
}
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
  private supports = new Map<number, SupportRead>()
  private defaults: AgentPickerEntry[]

  constructor(
    readonly key: string,
    private initial: AgentPickerEntry[],
    private reads: Reads
  ) {
    this.entries = initial
    this.defaults = initial
    for (const [i, entry] of initial.entries()) {
      if (entry.structuredDefaultsPending) {
        this.supports.set(i, { state: 'queued' })
      }
    }
    this.queued = {
      catalog: new Set(initial.flatMap((e, i) => (e.surfaces.length ? [i] : []))),
      support: new Set(this.supports.keys())
    }
  }

  observe(observer: Observer) {
    const first = this.observers.size === 0
    this.observers.add(observer)
    if (first) {
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
      return {
        ...entry,
        catalog: this.entries[i].catalog,
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
          ? this.reads.catalog(entry).then((catalog) => {
              if (catalog) {
                this.entries = this.entries.map((e, i) => (i === index ? { ...e, catalog } : e))
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
