/**
 * Renderer consumer registry for the `pty:sideEffect` channel.
 *
 * Why: with main as the side-effect parser for local-daemon/SSH PTYs, the
 * renderer no longer
 * derives title/bell/agent facts from bytes for those PTYs. This module is
 * the single channel subscriber; mounted panes and parked-tab watchers
 * register exactly one fact consumer per PTY (their existing policy
 * callbacks), so every fact has exactly one policy consumer regardless of
 * whether the tab is mounted, hidden, or parked. Facts for PTYs without a
 * registered consumer are dropped — mirroring today's eager-buffer behavior
 * where pre-mount output produces no attention side effects. The one exception
 * is a PTY whose consumer just unregistered: see the handoff buffer below.
 */
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { TerminalGitHubPRLink } from '../../../../shared/terminal-github-pr-link-detector'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../../../shared/terminal-side-effect-facts'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import { useAppStore } from '@/store'
import { retireConfirmedAgentExitResumeAuthority } from '@/lib/confirmed-agent-exit-resume-retirement'
import {
  bufferTerminalSideEffectFactHandoff,
  drainTerminalSideEffectFactHandoff,
  getTerminalSideEffectFactHandoffAuthority,
  openTerminalSideEffectFactHandoff,
  resetTerminalSideEffectFactHandoffs,
  type TerminalSideEffectFactAuthority
} from './terminal-side-effect-fact-handoff'

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
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
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
  onAgentExited?: (fact: Extract<TerminalSideEffectFact, { kind: 'agent-exited' }>) => void
  /** OSC 133;D — same policy hook the byte-mode commandLifecycle drove
   *  (stale agent-status row drop + interrupt-inference coordination). */
  onCommandFinished?: (bestEffortExitCode: number | null) => void
  onPrLink?: (link: TerminalGitHubPRLink) => void
  /** Command Code output scrape (no hooks): working seeds the status row;
   *  done is settle-checked by the pane policy before completing the turn. */
  onCommandCodeWorking?: (prompt: string) => void
  onCommandCodeDone?: (prompt: string) => void
  /** DECSET 2031 subscribe observed by main's tracker. Registered only by
   *  hidden-delivery-gated consumers (their bytes never arrive); it records the
   *  subscription for later theme-flip pushes, it does not answer. */
  onMode2031Subscribe?: () => void
  /** DECSET 2031 withdrawal observed by main's tracker. Clears the pane's
   *  subscription registry so later theme flips stop pushing CSI 997. */
  onMode2031Unsubscribe?: () => void
}

type ConsumerEntry = TerminalSideEffectFactAuthority & {
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Output sequence of the last live title fact applied. Replay snapshots at
   *  or before this point are stale and must not regress the title state. */
  lastLiveTitleSeq: number | null
}

const consumersByPtyId = new Map<string, ConsumerEntry>()
let channelUnsubscribe: (() => void) | null = null

function applyLiveFact(
  entry: ConsumerEntry,
  fact: TerminalSideEffectFact,
  batch: TerminalSideEffectBatch
): void {
  switch (fact.kind) {
    case 'agent-status':
      entry.callbacks.onAgentStatus?.(fact.payload)
      return
    case 'title':
      entry.lastLiveTitleSeq = batch.seq
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
      if (fact.executionHostConfirmed === true) {
        // Why: confirmed authority is valid only for this exact process and
        // pane boundary; never downgrade an ambiguous fact to an unconfirmed exit.
        if (
          !fact.incarnationId ||
          !entry.incarnationId ||
          !entry.paneKey ||
          !entry.tabId ||
          !entry.worktreeId ||
          !batch.paneKey ||
          !batch.tabId ||
          !batch.worktreeId ||
          fact.incarnationId !== entry.incarnationId ||
          entry.paneKey !== batch.paneKey ||
          entry.tabId !== batch.tabId ||
          entry.worktreeId !== batch.worktreeId
        ) {
          return
        }
        entry.callbacks.onAgentExited?.(fact)
        return
      }
      entry.callbacks.onAgentExited?.({ kind: 'agent-exited' })
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
    applyLiveFact(entry, fact, batch)
  }
}

// Why: a reveal remount unregisters the parked watcher synchronously, but the
// replacement pane registers only after its deferred rAF + async reattach
// resolves — and replay is title-only, so a bell or a command-code 'done'
// dropped in that window is lost for good. Only a PTY that just lost its
// consumer buffers (never-consumed PTYs still drop, per the module contract),
// bounded in time, batches, and PTYs so an abandoned handoff retains nothing.
export function dispatchTerminalSideEffectBatch(batch: TerminalSideEffectBatch): void {
  const entry = consumersByPtyId.get(batch.ptyId)
  if (!entry) {
    // Why: a confirmed exit can race pane teardown or arrive for byte-mode
    // panes that never register here; main's fact attribution outlives both.
    const handoffAuthority = getTerminalSideEffectFactHandoffAuthority(batch.ptyId)
    const confirmedExit = batch.facts.find(
      (fact) => fact.kind === 'agent-exited' && fact.executionHostConfirmed === true
    )
    if (
      !batch.replay &&
      batch.paneKey &&
      batch.tabId &&
      batch.worktreeId &&
      confirmedExit?.kind === 'agent-exited' &&
      confirmedExit.incarnationId &&
      handoffAuthority?.paneKey &&
      handoffAuthority.tabId &&
      handoffAuthority.worktreeId &&
      handoffAuthority?.incarnationId === confirmedExit.incarnationId &&
      handoffAuthority.paneKey === batch.paneKey &&
      handoffAuthority.tabId === batch.tabId &&
      handoffAuthority.worktreeId === batch.worktreeId
    ) {
      retireConfirmedAgentExitResumeAuthority(useAppStore.getState(), batch.paneKey, {
        tabId: batch.tabId,
        worktreeId: batch.worktreeId
      })
    }
    bufferTerminalSideEffectFactHandoff(batch)
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
  channelUnsubscribe = onSideEffect(dispatchTerminalSideEffectBatch)
}

export type TerminalSideEffectFactConsumerOptions = {
  ptyId: string
  incarnationId?: PtyIncarnationId | null
  paneKey?: string
  tabId?: string
  worktreeId?: string
  callbacks: TerminalSideEffectFactConsumerCallbacks
  /** Pull main's title-only replay snapshot on registration. Pane transports
   *  use this in place of deriving titles from eager-buffer byte replay.
   *  Ordinary parked watchers already have a current pane title; cold-started
   *  watchers request it because no pane populated their slot. */
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
  const inheritedAuthority = getTerminalSideEffectFactHandoffAuthority(options.ptyId)
  const canInherit =
    options.incarnationId == null &&
    inheritedAuthority?.paneKey === (options.paneKey ?? null) &&
    inheritedAuthority?.tabId === (options.tabId ?? null) &&
    inheritedAuthority?.worktreeId === (options.worktreeId ?? null)
  const entry: ConsumerEntry = {
    callbacks: options.callbacks,
    incarnationId: options.incarnationId ?? (canInherit ? inheritedAuthority.incarnationId : null),
    paneKey: options.paneKey ?? null,
    tabId: options.tabId ?? null,
    worktreeId: options.worktreeId ?? null,
    lastLiveTitleSeq: null
  }
  consumersByPtyId.set(options.ptyId, entry)
  // Why before the snapshot request: draining live facts sets lastLiveTitleSeq, so the async title replay is correctly dropped as stale.
  drainTerminalSideEffectFactHandoff(options.ptyId, (batch) => applyBatchToConsumer(entry, batch))

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
      // Why: the pane that replaces this consumer registers only after its async reattach resolves; hold facts across that handoff.
      openTerminalSideEffectFactHandoff(options.ptyId, entry)
    }
  }
}

/** Test seam: deliver a batch as if it arrived on the channel. */
export function _dispatchTerminalSideEffectBatchForTest(batch: TerminalSideEffectBatch): void {
  dispatchTerminalSideEffectBatch(batch)
}

/** Test seam: reset module state between tests. */
export function _resetTerminalSideEffectFactConsumersForTest(): void {
  consumersByPtyId.clear()
  resetTerminalSideEffectFactHandoffs()
  channelUnsubscribe?.()
  channelUnsubscribe = null
  persistedAuthorityFlagCache = undefined
}
