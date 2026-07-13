import React from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { NativeChatResolvedView } from '@/components/native-chat/NativeChatView'

/**
 * Read-only native-chat surface for an imported web chat opened as an editor
 * tab. PTY-decoupled: the synthetic `webchat:` terminalTabId has no runtime
 * owner, so the live-session hook resolves to the local transport, which reads
 * the imported conversation from chats.db.
 */
export function EditorWebChatTranscriptPanel({
  file
}: {
  file: OpenFile
}): React.JSX.Element | null {
  if (!file.webChatAgent || !file.webChatSessionId) {
    return null
  }
  const paneKey = `webchat:${file.webChatSessionId}`
  return (
    <NativeChatResolvedView
      readOnly
      paneKey={paneKey}
      terminalTabId={paneKey}
      agent={file.webChatAgent}
      sessionId={file.webChatSessionId}
      transcriptPath={null}
      targetPtyId={null}
    />
  )
}
