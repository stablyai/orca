import { useAppStore } from '@/store'
import type { PromptCacheTimerEntry } from '@/store/terminals/terminal-state'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-status/title/agent-title-owner'
import { resolveTerminalTitleAgentType } from '../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'

export type PromptCacheCommandBoundary = {
  observeTitle: (rawTitle: string) => void
  /** A nested shell inside the live agent leaks 133;D too, so D alone only arms a check of the next agent read. */
  onCommandFinished: () => void
  /** After a 133;D, a command start means the next agent read finds a relaunch, not the session D interrupted. */
  onCommandStarted: () => void
  /** A request is fresh session evidence no earlier command boundary can retire. */
  onRequest: () => void
  /** The agent exited or the shell was confirmed. */
  end: () => void
  /** A process read found this agent in the foreground. */
  onAgentRead: (agent: TerminalAgent) => void
  /** Only a live agent read is evidence here; shell verdicts arrive through end(), and the no-read trusted-D publish proves nothing. */
  onForegroundPublished: (entry: PaneForegroundAgentEntry) => void
}

/** Keeps the pane's cache session through 133;D until evidence shows the agent it belongs to ended. */
export function createPromptCacheCommandBoundary(args: {
  paneKey: string
  initialTitle?: string
  setCacheTimerStartedAt: (key: string, entry: PromptCacheTimerEntry | null) => void
}): PromptCacheCommandBoundary {
  const { paneKey, setCacheTimerStartedAt } = args
  // Undefined until a title is seen: only an observed reset to '' signals an exit.
  let lastRawTitle = args.initialTitle
  // The agent the session belonged to at 133;D (null when unknown) and whether a command started since.
  let check: { agent: TerminalAgent | null; relaunched: boolean } | null = null
  const end = (): void => {
    check = null
    setCacheTimerStartedAt(paneKey, null)
  }
  const onAgentRead = (agent: TerminalAgent): void => {
    const pending = check
    check = null
    if (
      pending !== null &&
      (pending.relaunched ||
        (pending.agent !== null &&
          resolveCompatibleAgentTypeForOwner(agent, pending.agent) !== pending.agent))
    ) {
      setCacheTimerStartedAt(paneKey, null)
    }
  }

  return {
    observeTitle: (rawTitle) => {
      lastRawTitle = rawTitle
    },
    onCommandFinished: () => {
      const state = useAppStore.getState()
      if (state.cacheTimerByKey[paneKey] === undefined) {
        check = null
        return
      }
      // An exiting agent resets its title before the shell's 133;D.
      if (lastRawTitle === '') {
        end()
        return
      }
      // Claude titles the pane with bare task text, so the foreground entry names the agent instead.
      const agent =
        (lastRawTitle ? resolveTerminalTitleAgentType(lastRawTitle) : null) ??
        state.paneForegroundAgentByPaneKey[paneKey]?.agent ??
        null
      check = { agent, relaunched: check?.relaunched ?? false }
    },
    onCommandStarted: () => {
      if (check !== null) {
        check.relaunched = true
      }
    },
    onRequest: () => {
      check = null
      setCacheTimerStartedAt(paneKey, 'requested')
    },
    end,
    onAgentRead,
    onForegroundPublished: (entry) => {
      if (entry.agentEvidence === 'process-read' && entry.agent) {
        onAgentRead(entry.agent)
      }
    }
  }
}
