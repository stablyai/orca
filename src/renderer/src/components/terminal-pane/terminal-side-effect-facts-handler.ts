/**
 * Renderer consumer registry for the `pty:sideEffect` channel.
 *
 * Why: with main as the side-effect parser for local-daemon/SSH PTYs
 * (docs/reference/terminal-side-effect-authority.md), the renderer no longer
 * derives title/bell/agent facts from bytes for those PTYs. This module is
 * the single channel subscriber; mounted panes and parked-tab watchers
 * register exactly one fact consumer per PTY (their existing policy
 * callbacks), so every fact has exactly one policy consumer regardless of
 * whether the tab is mounted, hidden, or parked. Facts for PTYs without a
 * registered consumer are dropped — mirroring today's eager-buffer behavior
 * where pre-mount output produces no attention side effects.
 */
import type { GlobalSettings } from '../../../../shared/types'
import type { TerminalGitHubPRLink } from '../../../../shared/terminal-github-pr-link-detector'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../../../shared/terminal-side-effect-facts'

// Why: cached once per session — the blocking read should only ever run on
// the pre-hydration startup path, never per pane bind.
let persistedAuthorityFlagCache: boolean | null | undefined

function readPersistedSideEffectAuthorityFlagSync(): boolean | null {
  if (persistedAuthorityFlagCache === undefined) {
    try {
      const getSync = (globalThis as { window?: Window }).window?.api?.settings?.getSync
      persistedAuthorityFlagCache =
        typeof getSync === 'function' ? (getSync()?.terminalMainSideEffectAuthority ?? null) : null
    } catch {
      persistedAuthorityFlagCache = null
    }
  }
  return persistedAuthorityFlagCache
}

/**
 * Structural authority predicate: main owns side effects for a PTY when its
 * bytes transit local main (everything except remote-runtime PTYs) and the
 * kill switch is on. Decided at transport/watcher creation — never per chunk —
 * so each fact has one consumer with no race.
 */
export function isMainTerminalSideEffectAuthorityForPty(args: {
  settings: Pick<GlobalSettings, 'terminalMainSideEffectAuthority'> | null
  /** Remote-runtime owner environment; null means bytes transit local main. */
  runtimeEnvironmentId: string | null
}): boolean {
  if (args.runtimeEnvironmentId !== null) {
    return false
  }
  if (args.settings !== null) {
    return args.settings.terminalMainSideEffectAuthority !== false
  }
  // Why: settings hydrate asynchronously, and the authority decision made
  // here at transport/watcher creation is never revisited. A pane bound
  // before hydration must honor the persisted kill switch — otherwise a user
  // who turned main authority off gets startup panes with no byte parsers
  // and a fact consumer they disabled. Surfaces without the sync read (web
  // remote clients, tests) keep the default-on behavior.
  return readPersistedSideEffectAuthorityFlagSync() !== false
}

export type TerminalSideEffectFactConsumerCallbacks = {
  /** `meta.staleWorkingTitleClear` marks facts derived from main's 3s
   *  stale-title timer — policy must clear title/cache state without
   *  scheduling task-complete notifications or unread attention. */
  onTitleChange?: (
    normalizedTitle: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string, meta?: { staleWorkingTitleClear?: boolean }) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** OSC 133;D — same policy hook the byte-mode commandLifecycle drove
   *  (stale agent-status row drop + interrupt-inference coordination). */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /** Command Code output scrape (no hooks): working seeds the status row;
   *  done is settle-checked by the pane policy before completing the turn. */
  onCommandCodeWorking?: (prompt: string) => void
  onCommandCodeDone?: (prompt: string) => void
  /** DECSET 2031 subscribe observed by main's tracker. Registered only by
   *  hidden-delivery-gated consumers (their bytes never arrive); the theme
   *  reply is sent renderer-side — query authority stays with the view. */
  onMode2031Subscribe?: () => void
}

type ConsumerEntry = {
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Output sequence of the last live title fact applied. Replay snapshots at
   *  or before this point are stale and must not regress the title state. */
  lastLiveTitleSeq: number | null
}

const consumersByPtyId = new Map<string, ConsumerEntry>()
let channelUnsubscribe: (() => void) | null = null

function applyLiveFact(entry: ConsumerEntry, fact: TerminalSideEffectFact, seq: number): void {
  switch (fact.kind) {
    case 'title':
      entry.lastLiveTitleSeq = seq
      entry.callbacks.onTitleChange?.(
        fact.normalizedTitle,
        fact.rawTitle,
        fact.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : undefined
      )
      return
    case 'bell':
      entry.callbacks.onBell?.()
      return
    case 'agent-working':
      entry.callbacks.onAgentBecameWorking?.()
      return
    case 'agent-idle':
      entry.callbacks.onAgentBecameIdle?.(
        fact.title,
        fact.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : undefined
      )
      return
    case 'agent-exited':
      entry.callbacks.onAgentExited?.()
      return
    case 'command-finished':
      entry.callbacks.onCommandFinished?.(fact.exitCode)
      return
    case 'pr-link':
      entry.callbacks.onPrLink?.(fact.link)
      return
    case 'command-code-working':
      entry.callbacks.onCommandCodeWorking?.(fact.prompt)
      return
    case 'command-code-done':
      entry.callbacks.onCommandCodeDone?.(fact.prompt)
      return
    case '2031-subscribe':
      entry.callbacks.onMode2031Subscribe?.()
  }
}

function applyBatchToConsumer(entry: ConsumerEntry, batch: TerminalSideEffectBatch): void {
  if (batch.replay) {
    // Why: the no-attention-replay rule — (re)attach snapshots restore title
    // state only; historical bells/completions must never fire again. A replay
    // older (by output sequence) than the last live title fact is stale.
    if (entry.lastLiveTitleSeq !== null && batch.seq <= entry.lastLiveTitleSeq) {
      return
    }
    for (const fact of batch.facts) {
      if (fact.kind === 'title') {
        entry.callbacks.onTitleChange?.(fact.normalizedTitle, fact.rawTitle)
      }
    }
    return
  }
  for (const fact of batch.facts) {
    applyLiveFact(entry, fact, batch.seq)
  }
}

function handleSideEffectBatch(batch: TerminalSideEffectBatch): void {
  const entry = consumersByPtyId.get(batch.ptyId)
  if (!entry) {
    return
  }
  applyBatchToConsumer(entry, batch)
}

function ensureSideEffectChannelSubscription(): void {
  if (channelUnsubscribe !== null) {
    return
  }
  // Why: optional-chained from globalThis so unit tests (and any non-preload
  // surface) without window.api degrade to "no channel" instead of throwing.
  const onSideEffect = (globalThis as { window?: Window }).window?.api?.pty?.onSideEffect
  if (typeof onSideEffect !== 'function') {
    return
  }
  channelUnsubscribe = onSideEffect(handleSideEffectBatch)
}

export type TerminalSideEffectFactConsumerOptions = {
  ptyId: string
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Pull main's title-only replay snapshot on registration. Pane transports
   *  use this in place of deriving titles from eager-buffer byte replay;
   *  parked watchers skip it because the pane's runtime title slot is already
   *  current at park time. */
  restoreTitleOnRegister?: boolean
}

/**
 * Register the single fact consumer for a PTY. A new registration replaces a
 * stale one for the same PTY (same semantics as the parked watcher registry):
 * two consumers would double-fire bell/completion policy for the same bytes.
 */
export function registerTerminalSideEffectFactConsumer(
  options: TerminalSideEffectFactConsumerOptions
): () => void {
  ensureSideEffectChannelSubscription()
  const entry: ConsumerEntry = {
    callbacks: options.callbacks,
    lastLiveTitleSeq: null
  }
  consumersByPtyId.set(options.ptyId, entry)

  if (options.restoreTitleOnRegister) {
    const getSnapshot = (globalThis as { window?: Window }).window?.api?.pty?.getSideEffectSnapshot
    if (typeof getSnapshot === 'function') {
      void getSnapshot(options.ptyId)
        .then((batch) => {
          // Why: apply only while this registration is still the live
          // consumer; a slow snapshot must not fire into a replaced one.
          if (batch && consumersByPtyId.get(options.ptyId) === entry) {
            applyBatchToConsumer(entry, { ...batch, replay: true })
          }
        })
        .catch(() => {})
    }
  }

  return () => {
    if (consumersByPtyId.get(options.ptyId) === entry) {
      consumersByPtyId.delete(options.ptyId)
    }
  }
}

/** Test seam: deliver a batch as if it arrived on the channel. */
export function _dispatchTerminalSideEffectBatchForTest(batch: TerminalSideEffectBatch): void {
  handleSideEffectBatch(batch)
}

/** Test seam: reset module state between tests. */
export function _resetTerminalSideEffectFactConsumersForTest(): void {
  consumersByPtyId.clear()
  channelUnsubscribe?.()
  channelUnsubscribe = null
  persistedAuthorityFlagCache = undefined
}
