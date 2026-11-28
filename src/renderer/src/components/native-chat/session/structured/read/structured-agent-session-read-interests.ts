import { withDocumentSavesOnly } from './document-viewer-visibility'
import type { StructuredAgentSessionReadEffects } from './structured-agent-session-read-owner-contract'

export function createStructuredAgentSessionReadInterests(
  sessionId: string,
  readers: ReadonlyMap<symbol, StructuredAgentSessionReadEffects>
) {
  const listeners = new Set<() => void>()
  const replyTextShown = () => [...readers.values()].some((reader) => reader.showsReplyText)
  return {
    replyTextShown,
    replyText: withDocumentSavesOnly(sessionId, {
      shown: replyTextShown,
      subscribe: (changed) => {
        listeners.add(changed)
        return () => listeners.delete(changed)
      }
    }),
    changed: (previousReplyText: boolean) => {
      if (replyTextShown() !== previousReplyText) {
        listeners.forEach((changed) => changed())
      }
    }
  }
}
