import { useAppStore } from '@/store'
import type { PromptCacheTimerEntry } from '@/store/terminals/terminal-state'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-status/title/agent-title-owner'
import { resolveTerminalTitleAgentType } from '../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'

export type PromptCacheCommandFinishedHold = {
  observeTitle: (rawTitle: string) => void
  /** 133;D precedes any relaunch's output; the shell read can land after a new agent already owns the foreground. */
  onCommandFinished: () => void
  /** A new command (133;C) means whatever the read finds is not the held session. */
  discard: () => void
  /** A live process read; the held session survives only if the agent it was held for still runs. */
  onForegroundRead: (agent: TerminalAgent | null) => void
  /** The pane's entry, or the held one while its read is pending. */
  entry: () => PromptCacheTimerEntry | undefined
  /** An idle edge while held must reach the restored entry, or the read would restore a stale 'requested'. */
  startCountdown: () => void
}

/** A nested shell's 133;D leaks while the agent's title stays up; an agent that exits resets its title first. */
export function createPromptCacheCommandFinishedHold(args: {
  paneKey: string
  initialTitle?: string
  setCacheTimerStartedAt: (key: string, entry: PromptCacheTimerEntry | null) => void
}): PromptCacheCommandFinishedHold {
  const { paneKey } = args
  let lastRawTitle = args.initialTitle ?? ''
  let held: { entry: PromptCacheTimerEntry; agent: TerminalAgent } | null = null

  return {
    observeTitle: (rawTitle) => {
      lastRawTitle = rawTitle
    },
    onCommandFinished: () => {
      // A repeated 133;D before the read lands must keep the entry the first one held.
      const state = useAppStore.getState()
      const entry = state.cacheTimerByKey[paneKey] ?? held?.entry
      // Claude now titles the pane with bare task text, so the foreground entry names the agent the read must confirm.
      const agent =
        resolveTerminalTitleAgentType(lastRawTitle) ??
        (lastRawTitle === '' ? null : (state.paneForegroundAgentByPaneKey[paneKey]?.agent ?? null))
      held = entry !== undefined && agent !== null ? { entry, agent } : null
      args.setCacheTimerStartedAt(paneKey, null)
    },
    discard: () => {
      held = null
    },
    onForegroundRead: (agent) => {
      const restore = held
      held = null
      if (
        restore !== null &&
        resolveCompatibleAgentTypeForOwner(agent, restore.agent) === restore.agent &&
        useAppStore.getState().cacheTimerByKey[paneKey] === undefined
      ) {
        args.setCacheTimerStartedAt(paneKey, restore.entry)
      }
    },
    entry: () => useAppStore.getState().cacheTimerByKey[paneKey] ?? held?.entry,
    startCountdown: () => {
      if (held !== null && useAppStore.getState().cacheTimerByKey[paneKey] === undefined) {
        held.entry = Date.now()
      } else {
        args.setCacheTimerStartedAt(paneKey, Date.now())
      }
    }
  }
}
