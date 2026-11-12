export type TerminalNotice = 'claude-old-terminal' | 'codex-shared-server'
export type TerminalNoticeStart = {
  paneKey: string
  generation?: number
  shown: boolean
}
export type TerminalNoticeLifetime = {
  readonly ptyId: string
  incarnationId?: string
  retired: boolean
  readonly dismissed: Set<TerminalNotice>
  start?: TerminalNoticeStart
}

// Notice contributions follow accepted bindings, rather than React panes or evictable buffers.
const lifetimes = new Map<string, TerminalNoticeLifetime>()

export function getTerminalNoticeLifetime(ptyId: string): TerminalNoticeLifetime | undefined {
  return lifetimes.get(ptyId)
}

export function isTerminalNoticeLifetimeCurrent(lifetime: TerminalNoticeLifetime): boolean {
  return !lifetime.retired && lifetimes.get(lifetime.ptyId) === lifetime
}

/** Only the current successful fresh/reattach owner may admit a process. */
export function admitTerminalNoticeLifetime(
  ptyId: string,
  options: { incarnationId?: string; fresh?: boolean } = {}
): TerminalNoticeLifetime {
  const current = lifetimes.get(ptyId)
  if (
    current &&
    !options.fresh &&
    (!options.incarnationId ||
      !current.incarnationId ||
      options.incarnationId === current.incarnationId)
  ) {
    current.incarnationId ??= options.incarnationId
    return current
  }
  if (current) {
    retireTerminalNoticeLifetime(current)
  }
  const lifetime: TerminalNoticeLifetime = {
    ptyId,
    ...(options.incarnationId ? { incarnationId: options.incarnationId } : {}),
    retired: false,
    dismissed: new Set()
  }
  lifetimes.set(ptyId, lifetime)
  return lifetime
}

/** Called after current attach/frame acceptance, never by a presentation read. */
export function admitTerminalNoticeStart(
  lifetime: TerminalNoticeLifetime,
  paneKey: string,
  generation?: number
): void {
  if (!isTerminalNoticeLifetimeCurrent(lifetime)) {
    return
  }
  const previous = lifetime.start
  if (previous) {
    // Generations belong to a leaf; moving a live process preserves its start.
    if (previous.paneKey !== paneKey || generation === undefined) {
      return
    }
    if (previous.generation === undefined) {
      previous.generation = generation
      return
    }
    if (generation <= previous.generation) {
      return
    }
  }
  lifetime.start = { paneKey, ...(generation !== undefined ? { generation } : {}), shown: false }
}

/** The canonical owner emits final retirement with the old capture, before its identity is lost. */
export function retireTerminalNoticeLifetime(lifetime: TerminalNoticeLifetime): void {
  if (lifetimes.get(lifetime.ptyId) === lifetime) {
    lifetimes.delete(lifetime.ptyId)
  }
  lifetime.retired = true
  lifetime.dismissed.clear()
  lifetime.start = undefined
}
