import { useAppStore } from '@/store'
import type { PromptCacheTimerEntry } from '@/store/terminals/terminal-state'
import type { LiveClaudeEvidence } from '@/lib/agent-status/evidence/prompt-cache-request-evidence'
import { detectAgentStatusFromTitle } from '../../../../../shared/agent-status/title/agent-title-status'
import { shouldSeedCacheTimerOnInitialTitle } from './cache-timer-seeding'

export type RestoredPromptCacheTimer = {
  /** The pane's first title, which may be a replay no working edge reported. */
  restore: (rawTitle: string) => void
  /** Any title; one whose activity moved past the restored title carries its own edges, ending the wait. */
  observeTitle: (rawTitle: string) => void
  /** The caller's live-process evidence changed. */
  retry: () => void
  /** A command started or finished, so a later read can only find a newer session than the restored one. */
  endWait: () => void
  dispose: () => void
}

/** Mounted and parked panes restore alike; only where live-process evidence comes from differs. */
export function createRestoredPromptCacheTimer(args: {
  paneKey: string
  allowInitialIdleSeed: () => boolean
  liveClaude: () => LiveClaudeEvidence
  /** Asks for one live process read; the caller calls retry when it lands. */
  requestProcessRead?: () => void
  setCacheTimerStartedAt: (key: string, entry: PromptCacheTimerEntry) => void
}): RestoredPromptCacheTimer {
  const { paneKey } = args
  let awaitingTitle: string | null = null
  let unsubscribeRows: (() => void) | null = null

  const stop = (): void => {
    unsubscribeRows?.()
    unsubscribeRows = null
    awaitingTitle = null
  }

  const evaluate = (rawTitle: string): void => {
    const state = useAppStore.getState()
    const restored = shouldSeedCacheTimerOnInitialTitle({
      rawTitle,
      allowInitialIdleSeed: args.allowInitialIdleSeed(),
      existing: state.cacheTimerByKey[paneKey],
      promptCacheTimerEnabled: state.settings?.promptCacheTimerEnabled ?? null,
      agentStatusHooksEnabled: state.settings?.agentStatusHooksEnabled ?? null,
      entry: state.agentStatusByPaneKey[paneKey],
      liveClaude: args.liveClaude(),
      now: Date.now()
    })
    if (restored !== 'await-hook-row' && restored !== 'await-process-read') {
      stop()
      if (typeof restored === 'number' || restored === 'requested') {
        args.setCacheTimerStartedAt(paneKey, restored)
      }
      return
    }
    if (awaitingTitle !== null) {
      return
    }
    awaitingTitle = rawTitle
    // Only this pane's row changes can decide, never unrelated store publications (#19371).
    if (state.settings?.agentStatusHooksEnabled !== false) {
      unsubscribeRows = state.subscribeAgentStatusChanges((changes) => {
        if (awaitingTitle !== null && changes.some((change) => change.paneKey === paneKey)) {
          evaluate(awaitingTitle)
        }
      })
    }
    if (restored === 'await-process-read') {
      args.requestProcessRead?.()
    }
  }

  return {
    restore: evaluate,
    observeTitle: (rawTitle) => {
      // Spinner frames change the text, not the activity; only a new activity brings its own edge.
      if (
        awaitingTitle !== null &&
        detectAgentStatusFromTitle(awaitingTitle) !== detectAgentStatusFromTitle(rawTitle)
      ) {
        stop()
      }
    },
    retry: () => {
      if (awaitingTitle !== null) {
        evaluate(awaitingTitle)
      }
    },
    endWait: stop,
    dispose: stop
  }
}
