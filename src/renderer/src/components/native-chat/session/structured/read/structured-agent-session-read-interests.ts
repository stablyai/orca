import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'
import { withDocumentSavesOnly } from './document-viewer-visibility'
import type { StructuredAgentSessionReadEffects } from './structured-agent-session-read-owner-contract'

export function createStructuredAgentSessionReadInterests(
  sessionId: string,
  local: boolean,
  readers: ReadonlyMap<symbol, StructuredAgentSessionReadEffects>,
  refresh: () => void
) {
  const listeners = new Set<() => void>()
  const replyTextShown = () => [...readers.values()].some((reader) => reader.showsReplyText)
  const receiptProvider = () =>
    local
      ? [...readers.values()].find((reader) => reader.receiptProvider)?.receiptProvider
      : undefined
  const shownProvider = () => {
    const provider = receiptProvider()
    return provider && getWindowParkVisible() ? provider : undefined
  }
  let openedProvider: StructuredAgentSessionReadEffects['receiptProvider']
  let unwatch: (() => void) | undefined
  const dispose = () => {
    unwatch?.()
    unwatch = undefined
  }
  const refreshIfChanged = () => {
    if (readers.size && openedProvider !== shownProvider()) {
      refresh()
    }
  }
  return {
    replyTextShown,
    replyText: withDocumentSavesOnly(sessionId, {
      shown: replyTextShown,
      subscribe: (changed) => {
        listeners.add(changed)
        return () => listeners.delete(changed)
      }
    }),
    opened: () => (openedProvider = shownProvider()),
    closed: () => {
      openedProvider = undefined
    },
    changed: (previousReplyText: boolean) => {
      if (replyTextShown() !== previousReplyText) {
        listeners.forEach((changed) => changed())
      }
      if (receiptProvider()) {
        unwatch ??= subscribeWindowParkVisibility(refreshIfChanged)
      } else {
        dispose()
      }
      refreshIfChanged()
    },
    dispose
  }
}
