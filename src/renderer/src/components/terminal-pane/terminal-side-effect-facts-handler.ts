/** One fact consumer per local-main/SSH PTY, mounted or parked. Never-consumed PTYs drop attention facts; recently unregistered consumers alone open a bounded handoff buffer. */
import type { AgentIdleEdgeMeta } from '../../../../shared/terminal-output-side-effects'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { TerminalGitHubPRLink } from '../../../../shared/terminal-github-pr-link-detector'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../../../shared/terminal-side-effect-facts'

// Cache the blocking persisted-switch read at startup, never per pane bind.
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

/** Main owns non-remote-runtime facts when enabled; choose once at creation to avoid racing byte/fact consumers. */
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
  // Pre-hydration bindings must honor the persisted switch because authority is never revisited; web/test APIs lacking sync read retain default-on behavior.
  return readPersistedSideEffectAuthorityFlagSync() !== false
}

export type TerminalSideEffectFactConsumerCallbacks = {
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
  /** Main’s staleWorkingTitleClear facts clear title/cache only, never completion or unread attention. */
  onTitleChange?: (
    normalizedTitle: string,
    rawTitle: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string, meta?: AgentIdleEdgeMeta) => void
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
  /** Record live mode-2031 subscriptions for hidden-view theme pushes; this fact does not answer queries. */
  onMode2031Subscribe?: () => void
  /** DECSET 2031 withdrawal observed by main's tracker. Clears the pane's
   *  subscription registry so later theme flips stop pushing CSI 997. */
  onMode2031Unsubscribe?: () => void
}

type ConsumerEntry = {
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Last applied live-title sequence; snapshots at/before it cannot regress title state. */
  lastLiveTitleSeq: number | null
}

const consumersByPtyId = new Map<string, ConsumerEntry>()
let channelUnsubscribe: (() => void) | null = null

function applyLiveFact(entry: ConsumerEntry, fact: TerminalSideEffectFact, seq: number): void {
  switch (fact.kind) {
    case 'agent-status':
      entry.callbacks.onAgentStatus?.(fact.payload)
      return
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
      entry.callbacks.onAgentBecameIdle?.(fact.title, {
        ...(fact.status ? { status: fact.status } : {}),
        ...(fact.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
      })
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
      return
    case '2031-unsubscribe':
      entry.callbacks.onMode2031Unsubscribe?.()
  }
}

function applyBatchToConsumer(entry: ConsumerEntry, batch: TerminalSideEffectBatch): void {
  if (batch.replay) {
    // Replay restores only titles, never historical attention; reject titles older than the latest live sequence.
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

// Bounded handoff buffering bridges watcher removal and async pane registration because replay cannot restore live bells/done. Never-consumed PTYs still drop facts.
const HANDOFF_FACT_BUFFER_TTL_MS = 15_000
const MAX_HANDOFF_FACT_BATCHES = 64
const MAX_HANDOFF_FACT_PTYS = 32

type HandoffFactBuffer = {
  batches: TerminalSideEffectBatch[]
  expiresAtMs: number
  expiryTimer: ReturnType<typeof setTimeout>
}
const handoffFactBuffersByPtyId = new Map<string, HandoffFactBuffer>()

function deleteHandoffFactBuffer(ptyId: string): void {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  if (buffer) {
    clearTimeout(buffer.expiryTimer)
    handoffFactBuffersByPtyId.delete(ptyId)
  }
}

function openHandoffFactBuffer(ptyId: string): void {
  const nowMs = Date.now()
  for (const [bufferedPtyId, buffer] of handoffFactBuffersByPtyId) {
    if (buffer.expiresAtMs <= nowMs) {
      deleteHandoffFactBuffer(bufferedPtyId)
    }
  }
  deleteHandoffFactBuffer(ptyId)
  if (handoffFactBuffersByPtyId.size >= MAX_HANDOFF_FACT_PTYS) {
    const oldestPtyId = handoffFactBuffersByPtyId.keys().next().value
    if (typeof oldestPtyId === 'string') {
      deleteHandoffFactBuffer(oldestPtyId)
    }
  }
  const buffer: HandoffFactBuffer = {
    batches: [],
    expiresAtMs: nowMs + HANDOFF_FACT_BUFFER_TTL_MS,
    expiryTimer: setTimeout(() => {
      if (handoffFactBuffersByPtyId.get(ptyId) === buffer) {
        handoffFactBuffersByPtyId.delete(ptyId)
      }
    }, HANDOFF_FACT_BUFFER_TTL_MS)
  }
  buffer.expiryTimer.unref?.()
  handoffFactBuffersByPtyId.set(ptyId, buffer)
}

function bufferHandoffFactBatch(batch: TerminalSideEffectBatch): void {
  const buffer = handoffFactBuffersByPtyId.get(batch.ptyId)
  if (!buffer) {
    return
  }
  if (buffer.expiresAtMs <= Date.now()) {
    deleteHandoffFactBuffer(batch.ptyId)
    return
  }
  // Why: replay batches are snapshots the next consumer requests for itself.
  if (batch.replay) {
    return
  }
  if (buffer.batches.length >= MAX_HANDOFF_FACT_BATCHES) {
    buffer.batches.shift()
  }
  buffer.batches.push(batch)
}

function drainHandoffFactBuffer(ptyId: string, entry: ConsumerEntry): void {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  if (!buffer) {
    return
  }
  deleteHandoffFactBuffer(ptyId)
  if (buffer.expiresAtMs <= Date.now()) {
    return
  }
  for (const batch of buffer.batches) {
    applyBatchToConsumer(entry, batch)
  }
}

export function dispatchTerminalSideEffectBatch(batch: TerminalSideEffectBatch): void {
  const entry = consumersByPtyId.get(batch.ptyId)
  if (!entry) {
    bufferHandoffFactBatch(batch)
    return
  }
  applyBatchToConsumer(entry, batch)
}

function ensureSideEffectChannelSubscription(): void {
  if (channelUnsubscribe !== null) {
    return
  }
  // Web/test surfaces lacking preload must degrade to no channel rather than throw.
  const onSideEffect = (globalThis as { window?: Window }).window?.api?.pty?.onSideEffect
  if (typeof onSideEffect !== 'function') {
    return
  }
  channelUnsubscribe = onSideEffect(dispatchTerminalSideEffectBatch)
}

export type TerminalSideEffectFactConsumerOptions = {
  ptyId: string
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Request title-only replay instead of eager-byte parsing; only cold-start watchers need it because ordinary parks retain current titles. */
  restoreTitleOnRegister?: boolean
}

/** Replace stale registrations so one PTY never double-fires bell/completion policy. */
export function registerTerminalSideEffectFactConsumer(
  options: TerminalSideEffectFactConsumerOptions
): () => void {
  ensureSideEffectChannelSubscription()
  const entry: ConsumerEntry = {
    callbacks: options.callbacks,
    lastLiveTitleSeq: null
  }
  consumersByPtyId.set(options.ptyId, entry)
  // Why before the snapshot request: draining live facts sets lastLiveTitleSeq, so the async title replay is correctly dropped as stale.
  drainHandoffFactBuffer(options.ptyId, entry)

  if (options.restoreTitleOnRegister) {
    const getSnapshot = (globalThis as { window?: Window }).window?.api?.pty?.getSideEffectSnapshot
    if (typeof getSnapshot === 'function') {
      void getSnapshot(options.ptyId)
        .then((batch) => {
          // Slow replay applies only while this registration remains current.
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
      // Why: the pane that replaces this consumer registers only after its async reattach resolves; hold facts across that handoff.
      openHandoffFactBuffer(options.ptyId)
    }
  }
}

export function _dispatchTerminalSideEffectBatchForTest(batch: TerminalSideEffectBatch): void {
  dispatchTerminalSideEffectBatch(batch)
}

export function _resetTerminalSideEffectFactConsumersForTest(): void {
  consumersByPtyId.clear()
  for (const ptyId of Array.from(handoffFactBuffersByPtyId.keys())) {
    deleteHandoffFactBuffer(ptyId)
  }
  channelUnsubscribe?.()
  channelUnsubscribe = null
  persistedAuthorityFlagCache = undefined
}
