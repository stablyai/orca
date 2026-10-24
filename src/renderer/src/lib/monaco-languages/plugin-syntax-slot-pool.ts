// Why slots: Monaco cannot unregister a language, so plugin languages borrow a bounded set of
// fixed language ids instead of registering a new id per plugin, version and reload.
export const PLUGIN_SYNTAX_SLOT_LIMIT = 512
// Unused languages stay bound for a quick reopen, up to this many, before their engines go.
const IDLE_SLOT_LIMIT = 16

type Slot<Engine> = {
  languageId: string
  key: string | null
  engine: Engine | null
  refs: number
  lastUsed: number
}

export type PluginSyntaxLease = { languageId: string; release: () => void }

export class PluginSyntaxSlotPool<
  Engine extends { dispose: () => void; releaseModels: () => void }
> {
  private readonly slots: Slot<Engine>[] = []
  private clock = 0

  constructor(
    private readonly options: {
      register: (languageId: string) => void
      create: (languageId: string, key: string) => Engine
      limit?: number
    }
  ) {}

  /** Null when every slot is in use; the caller shows plain text. */
  acquire(key: string): PluginSyntaxLease | null {
    const slot = this.slots.find((candidate) => candidate.key === key) ?? this.claim(key)
    if (!slot) {
      return null
    }
    slot.refs += 1
    slot.lastUsed = ++this.clock
    let released = false
    return {
      languageId: slot.languageId,
      release: () => {
        if (released) {
          return
        }
        released = true
        slot.refs -= 1
        slot.lastUsed = ++this.clock
        if (slot.refs === 0) {
          slot.engine?.releaseModels()
        }
        this.trimIdle()
      }
    }
  }

  private claim(key: string): Slot<Engine> | null {
    let slot = this.slots.find((candidate) => candidate.key === null)
    if (!slot && this.slots.length < (this.options.limit ?? PLUGIN_SYNTAX_SLOT_LIMIT)) {
      const languageId = `orca-plugin-syntax-${this.slots.length}`
      this.options.register(languageId)
      slot = { languageId, key: null, engine: null, refs: 0, lastUsed: 0 }
      this.slots.push(slot)
    }
    slot ??= this.leastRecentlyUsedIdle()
    if (!slot) {
      return null
    }
    this.unbind(slot)
    slot.key = key
    slot.engine = this.options.create(slot.languageId, key)
    return slot
  }

  private trimIdle(): void {
    const idle = this.slots.filter((slot) => slot.key !== null && slot.refs === 0)
    for (let excess = idle.length - IDLE_SLOT_LIMIT; excess > 0; excess -= 1) {
      const oldest = this.leastRecentlyUsedIdle()
      if (oldest) {
        this.unbind(oldest)
      }
    }
  }

  private leastRecentlyUsedIdle(): Slot<Engine> | undefined {
    let oldest: Slot<Engine> | undefined
    for (const slot of this.slots) {
      if (slot.key !== null && slot.refs === 0 && (!oldest || slot.lastUsed < oldest.lastUsed)) {
        oldest = slot
      }
    }
    return oldest
  }

  private unbind(slot: Slot<Engine>): void {
    slot.engine?.releaseModels()
    slot.engine?.dispose()
    slot.engine = null
    slot.key = null
  }
}
