import { expect, it } from 'vitest'
import type { StructuredAgentSessionCommandOutcome } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'

const { dispatchNativeChatStructuredComposerText } =
  await import('./native-chat-structured-composer-dispatch')
const { holdBrowserAttachmentFiles } = await import('@/lib/files/drop/browser-attachment-files')
const { formatNativeChatFileReference } =
  await import('../../../../../../shared/native-chat/input/composer/agent-image-paste')
const { nativeChatBrowserFileRefusalParts } =
  await import('../../attachments/native-chat-browser-file-references')
const { agentSessionWriteNoticeText } =
  await import('../../messages/notices/agent-session-write-notice-text')
const { worktreeCreationFirstSendNeedsChat } =
  await import('@/lib/workspace/creation/worktree-creation-first-send')

/** A composer transport that records every command and send that would leave the composer. */
const recordingTransport = (stagingScope?: string) => {
  const left: string[] = []
  return {
    left,
    transport: {
      dispatchCommand: async (text: string): Promise<StructuredAgentSessionCommandOutcome> => {
        left.push(`command:${text}`)
        return { handled: false, accepted: false, error: null }
      },
      send: (text: string) => {
        left.push(`send:${text}`)
        return true
      },
      ...(stagingScope ? { attachmentStagingScope: stagingScope } : {})
    }
  }
}

// A draft can name a browser file it cannot send: a restored reference saved before a reload (its bytes
// lived only in that renderer), or a returned copy of a file another chat now owns. Send with no
// preparation refuses it right here, before any command or send leaves, while the composer still owns
// the draft (so nothing is cleared), naming the file to remove and attach again.
it('refuses a send naming a browser file before anything leaves the composer', async () => {
  const [stale] = holdBrowserAttachmentFiles([new File(['x'], 'notes.txt')])
  const { left, transport } = recordingTransport()

  const outcome = await dispatchNativeChatStructuredComposerText(
    transport,
    `/compact keep ${formatNativeChatFileReference(stale)}`
  )

  expect(outcome).toEqual({
    accepted: false,
    error: agentSessionWriteNoticeText(nativeChatBrowserFileRefusalParts([stale])),
    revealsTranscript: false
  })
  expect(left).toEqual([])
})

// A pending creation's composer captures its first send to prepare later (its files are staged there),
// so it is admitted; the launch's own send is then admitted or refused where every message leaves.
it('admits a pending creation capture naming its staged browser files', async () => {
  const [image] = holdBrowserAttachmentFiles([new File(['x'], 'shot.png')])
  const { left, transport } = recordingTransport('pending-creation:browser-files')

  const outcome = await dispatchNativeChatStructuredComposerText(transport, 'look at this', [
    { id: 'chip', path: image }
  ])

  expect(outcome.accepted).toBe(true)
  expect(left).toEqual(['command:look at this', 'send:look at this'])
})

// A first send naming a browser file stays in chat: a terminal agent would be handed the renderer-only
// reference as plain text, and only a chat refuses it with its notice.
it('keeps a first send naming a browser file in chat', () => {
  const [file] = holdBrowserAttachmentFiles([new File(['x'], 'notes.txt')])
  const textOnly = { text: `see ${formatNativeChatFileReference(file)}` }
  expect(worktreeCreationFirstSendNeedsChat(textOnly, undefined, () => false)).toBe(true)
  expect(worktreeCreationFirstSendNeedsChat({ text: 'plain' }, undefined, () => false)).toBe(false)
})
