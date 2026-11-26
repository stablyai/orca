// A reader's synchronous credit to show one exact command, updated at validated stream ingress
// before coalescing and React. Every loss is sticky for the openings it reaches.

import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { admitAgentSessionBackgroundTaskState } from '../../background-tasks/agent-session-background-task-state-admission'
import {
  commandDetailKeysOf,
  decodeCommandDetailsAvailable,
  commandDetailTupleKey,
  type AgentSessionCommandDetailTuple
} from '../../background-tasks/agent-session-command-details'
import { admitsAgentSessionBatch } from './structured-agent-session-batch-admission'

/** What the live read tells the latch, synchronously and in stream order. */
export type StructuredAgentSessionLiveReadCredit = {
  /** Each open-generation advance, before the open's first await. */
  openGenerationAdvanced: (generation: number) => void
  /** The cursor this generation's subscription actually sends, null when it sends none. */
  subscribeCursor: (generation: number, cursor: AgentJournalCursor | null) => void
  /** Every decoded frame of the current open, before snapshot handling and coalescing, with the
   *  runtime that authenticated its transport when the transport says. */
  observeFrame: (event: AgentSessionSubscribeEvent, generation: number, runtimeId?: string) => void
}

/** Credit is bound to one transport instance's open generation; a bare number repeats across runs. */
export type CommandDetailCreditScope = { readonly transport: object; readonly generation: number }

type Baseline = { epoch: string | null; cursor: AgentJournalCursor | null }

export type CommandDetailOpening = {
  readonly tuple: AgentSessionCommandDetailTuple
  readonly fence: number | null
  /** The authenticated runtime whose frames granted this credit; requests and replies must match. */
  readonly runtimeId: string | undefined
  /** Not lost, still on the latch's current connected scope, and the pinned identity holds. */
  valid: () => boolean
  /** `valid()`, and on any failure the opening latches itself lost and notifies first. */
  check: () => boolean
  readonly lost: boolean
  /** Fires once, when the opening is lost. */
  onLost: (listener: () => void) => () => void
  close: () => void
}

export type CommandDetailAuthority = {
  /** Clears credit and loses every opening; only the open-generation callback passes a scope. */
  invalidate: (scope: CommandDetailCreditScope | null) => void
  /** The cursor this scope's subscription actually sent seeds its admission baseline. */
  seed: (scope: CommandDetailCreditScope, cursor: AgentJournalCursor | null) => void
  /** One decoded frame on `scope`, before snapshot/reset handling and before coalescing. A frame
   *  naming a different runtime than the one that granted credit clears it and loses openings. */
  observe: (
    scope: CommandDetailCreditScope,
    event: AgentSessionSubscribeEvent,
    runtimeId?: string
  ) => void
  /** A new opening for an available tuple on the current connected scope, else null. */
  open: (
    tuple: AgentSessionCommandDetailTuple,
    pinnedCurrent: () => boolean
  ) => CommandDetailOpening | null
  /** Diagnostics and tests. */
  inspect: () => {
    scope: CommandDetailCreditScope | null
    connected: boolean
    fence: number | null
    available: ReadonlySet<string>
    baseline: Baseline | null
    runtimeId: string | undefined
  }
}

function sameScope(
  left: CommandDetailCreditScope | null,
  right: CommandDetailCreditScope | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.transport === right.transport &&
    left.generation === right.generation
  )
}

type OpeningState = {
  opening: CommandDetailOpening
  scope: CommandDetailCreditScope
  key: string
  fence: number | null
  lose: () => void
}

export function createCommandDetailAuthority(): CommandDetailAuthority {
  let scope: CommandDetailCreditScope | null = null
  let connected = false
  let fence: number | null = null
  let available: ReadonlySet<string> = new Set()
  let baseline: Baseline | null = null
  /** The runtime whose replacement frame established the current credit. */
  let runtimeId: string | undefined
  const openings = new Set<OpeningState>()

  const loseAll = (): void => {
    for (const entry of openings) {
      entry.lose()
    }
  }
  const clearCredit = (): void => {
    available = new Set()
    fence = null
    connected = false
    runtimeId = undefined
  }

  /** Latest admitted roster wins, whatever its fence; existing openings survive only unchanged. */
  const applyRoster = (
    frameFence: number | null,
    state: Parameters<typeof admitAgentSessionBackgroundTaskState>[0]
  ): void => {
    // Decoded from this frame against its own admitted children: roster admission drops the list.
    const keys = commandDetailKeysOf({
      commandDetailsAvailable: decodeCommandDetailsAvailable(
        state?.commandDetailsAvailable,
        admitAgentSessionBackgroundTaskState(state)?.children
      )
    })
    for (const entry of openings) {
      if (!keys.has(entry.key) || entry.fence !== frameFence) {
        entry.lose()
      }
    }
    available = keys
    fence = frameFence
    connected = true
  }

  const authority: CommandDetailAuthority = {
    invalidate: (next) => {
      clearCredit()
      scope = next
      // A new scope starts with no baseline; seed() or its own replacement frame supplies one.
      baseline = null
      loseAll()
    },
    seed: (seeded, cursor) => {
      if (!sameScope(scope, seeded)) {
        return
      }
      baseline = cursor ? { epoch: cursor.epoch, cursor } : null
    },
    observe: (frameScope, event, frameRuntimeId) => {
      // A frame never adopts or assigns a scope; a null or stale scope changes nothing.
      if (!sameScope(scope, frameScope) || event.type === 'end') {
        return
      }
      if (event.type === 'snapshot' || event.type === 'reset') {
        // Admitted as a replacement: lose every opening, keep the scope, then install its roster.
        loseAll()
        clearCredit()
        if (event.backgroundTasks !== undefined) {
          applyRoster(event.fence, event.backgroundTasks)
        }
        runtimeId = frameRuntimeId
        const page = event.page
        baseline = { epoch: page.epoch, cursor: page.liveCursor ?? page.window.nextCursor }
        return
      }
      if (connected && frameRuntimeId !== runtimeId) {
        // Another runtime answering on this stream proves nothing it credited: sticky loss.
        loseAll()
        clearCredit()
        baseline = null
        return
      }
      if (!baseline || !admitsAgentSessionBatch(baseline, event.batch.cursor)) {
        return
      }
      baseline = { epoch: event.batch.cursor.epoch, cursor: event.batch.cursor }
      if (event.backgroundTasks !== undefined) {
        applyRoster(event.fence ?? null, event.backgroundTasks)
        runtimeId = frameRuntimeId
      }
    },
    open: (tuple, pinnedCurrent) => {
      const key = commandDetailTupleKey(tuple)
      if (!connected || scope === null || !available.has(key)) {
        return null
      }
      const openedScope = scope
      const listeners = new Set<() => void>()
      let lost = false
      const openedFence = fence
      const openedRuntimeId = runtimeId
      // Called only after `entry` below is initialized.
      const lose = (): void => {
        if (lost) {
          return
        }
        lost = true
        openings.delete(entry)
        for (const listener of listeners) {
          listener()
        }
        listeners.clear()
      }
      const valid = (): boolean =>
        !lost && connected && sameScope(scope, openedScope) && pinnedCurrent()
      const opening: CommandDetailOpening = {
        tuple,
        fence: openedFence,
        runtimeId: openedRuntimeId,
        valid,
        check: () => {
          if (valid()) {
            return true
          }
          lose()
          return false
        },
        get lost() {
          return lost
        },
        onLost: (listener) => {
          if (lost) {
            listener()
            return () => {}
          }
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close: () => {
          openings.delete(entry)
          listeners.clear()
          lost = true
        }
      }
      const entry: OpeningState = { scope: openedScope, key, fence: openedFence, lose, opening }
      openings.add(entry)
      return entry.opening
    },
    inspect: () => ({ scope, connected, fence, available, baseline, runtimeId })
  }
  return authority
}
