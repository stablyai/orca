import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { attemptStructuredAgentSessionSend } from './structured-agent-session-send-attempt'
import {
  findStructuredAgentSessionPendingSend,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'
import {
  nativeChatBrowserFileReferences,
  nativeChatBrowserFileRefusalParts
} from '../../../attachments/native-chat-browser-file-references'
import {
  beginSend,
  finish,
  handBack,
  handBackRefused,
  retainUnconfirmed,
  runtimes,
  settleRecorded,
  type StructuredAgentSessionSent
} from './structured-agent-session-send-runtime'

async function attempt(entry: StructuredAgentSessionPendingSend): Promise<void> {
  const runtime = runtimes.get(entry.clientMessageId)
  if (!runtime) {
    return
  }
  const outcome = await attemptStructuredAgentSessionSend({
    entry,
    target: runtime.target,
    reconcile: runtime.activity.settle,
    beforeIssue: () => {
      runtime.activity.issue()
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
        issued: true
      })
    },
    abandoned: () => runtime.abort.signal.aborted || runtimes.get(entry.clientMessageId) !== runtime
  })
  const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  if (!outcome || !current) {
    return
  }
  if (outcome.kind === 'not-sent') {
    handBack(current, outcome.parts)
  } else if (outcome.evidence.kind === 'recorded') {
    settleRecorded(current, outcome.submission, 'reply', outcome.cursor)
  } else if (outcome.evidence.kind === 'not-recorded') {
    handBackRefused(current, outcome.evidence.failure)
  } else {
    retainUnconfirmed(current)
  }
}

/**
 * Why a message body may not leave the renderer: it has no content, or it still names a renderer-only
 * browser file (one its preparation did not turn into a host upload). The body is never edited here:
 * it goes out whole or not at all, so its image numbering always matches its images.
 */
export function structuredAgentSessionUnsendableBody(
  body: StructuredAgentSessionPendingSend['body']
): { kind: 'empty' } | { kind: 'browser-files'; references: string[] } | null {
  if (body.blocks.length === 0) {
    return { kind: 'empty' }
  }
  const references = nativeChatBrowserFileReferences(
    body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    body.blocks.flatMap((block) =>
      block.type === 'image-ref' && block.path ? [{ path: block.path }] : []
    )
  )
  return references.length ? { kind: 'browser-files', references } : null
}

/**
 * Every message leaves for the host here (or through the create that owns it, which admits it the same
 * way first). A body that may not leave ends before any request: with no content it is dropped, and
 * one naming a browser file comes back to the composer with a notice naming those files.
 */
export function dispatchStructuredAgentSessionSend(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget
): StructuredAgentSessionSent {
  const sent = beginSend(entry, target)
  const unsendable = structuredAgentSessionUnsendableBody(entry.body)
  if (unsendable?.kind === 'empty') {
    finish(entry, 'dropped')
  } else if (unsendable) {
    handBack(entry, nativeChatBrowserFileRefusalParts(unsendable.references))
  } else {
    void attempt(entry)
  }
  return sent
}
