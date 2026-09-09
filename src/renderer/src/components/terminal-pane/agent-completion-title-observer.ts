import { detectAgentStatusFromTitle, type AgentStatus } from '../../../../shared/agent-detection'
import {
  titleHasExplicitAgentIdentity,
  titleIsInconclusiveNativeDroidTitle
} from './title-agent-identity'
type TitleObserverOptions = {
  getLastStatus: () => AgentStatus | null
  setLastStatus: (status: AgentStatus | null) => void
  hasAgentEvidence: () => boolean
  establishAgentEvidence: () => void
  recordPaneActivity: () => void
  recordTitleWorking: () => boolean
  holdTitleCompletionPending: (title: string) => void
  hasPendingTitle: () => boolean
  dropPendingTitle: () => void
  markTitleCompletionNotified: (title: string) => void
  dispatchTitleCompletion: (title: string) => void
}

export function createAgentCompletionTitleObserver({
  getLastStatus,
  setLastStatus,
  hasAgentEvidence,
  establishAgentEvidence,
  recordPaneActivity,
  recordTitleWorking,
  holdTitleCompletionPending,
  hasPendingTitle,
  dropPendingTitle,
  markTitleCompletionNotified,
  dispatchTitleCompletion
}: TitleObserverOptions) {
  function titleCompletionAgentIdentity(title: string): string | null {
    const normalized = title.toLowerCase()
    if (/\bcodex\b/.test(normalized)) {
      return 'codex'
    }
    if (/\bclaude\b/.test(normalized)) {
      return 'claude'
    }
    if (/\bgemini\b/.test(normalized)) {
      return 'gemini'
    }
    if (/\bcursor(?: agent)?\b/.test(normalized)) {
      return 'cursor'
    }
    if (/\bopencode\b/.test(normalized)) {
      return 'opencode'
    }
    if (/\bdroid\b/.test(normalized)) {
      return 'droid'
    }
    if (/\bhermes\b/.test(normalized)) {
      return 'hermes'
    }
    if (/\baider\b/.test(normalized)) {
      return 'aider'
    }
    if (/\bpi\b/.test(normalized) || normalized.includes('\u03c0')) {
      return 'pi'
    }
    return null
  }

  function dispatchTitle(title: string): void {
    markTitleCompletionNotified(title)
    dispatchTitleCompletion(title)
  }

  function observeTitle(title: string): void {
    recordPaneActivity()
    const status = detectAgentStatusFromTitle(title)
    const inconclusiveDroidTitle = titleIsInconclusiveNativeDroidTitle(title)
    const explicitIdentity = titleHasExplicitAgentIdentity(title) && !inconclusiveDroidTitle
    const hadPendingTitle = hasPendingTitle()
    if (explicitIdentity) {
      establishAgentEvidence()
    }

    if (status === 'working') {
      // Why: a rejected working title is a post-hook-completion replay; leave lastStatus untouched so it can't open a completion branch.
      if (!recordTitleWorking()) {
        return
      }
    } else if (getLastStatus() === 'working') {
      if (inconclusiveDroidTitle) {
        setLastStatus(status)
        return
      }
      if (status === null && !titleHasExplicitAgentIdentity(title)) {
        holdTitleCompletionPending(title)
        setLastStatus(status)
        return
      }
      if (hasAgentEvidence()) {
        dispatchTitle(title)
      } else {
        holdTitleCompletionPending(title)
      }
    } else if (hadPendingTitle && status !== null && explicitIdentity) {
      dropPendingTitle()
      dispatchTitle(title)
    }
    setLastStatus(status)
  }

  function observeClassifiedTitleCompletion(title: string): void {
    if (titleHasExplicitAgentIdentity(title)) {
      establishAgentEvidence()
    }
    if (hasAgentEvidence()) {
      dispatchTitle(title)
    } else {
      holdTitleCompletionPending(title)
    }
  }

  return {
    observeTitle,
    observeClassifiedTitleCompletion,
    titleCompletionAgentIdentity
  }
}
