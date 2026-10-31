import {
  agentSessionPastedTextName,
  type AgentSessionAttachmentClipboardTarget
} from '../../../../shared/agent-session-attachments'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { blobToBase64 } from '@/lib/image-blob-png'
import { saveClipboardImageAsWebAgentSessionAttachment } from './web-agent-session-attachment-upload'

/** A long text paste saved as a file: only a chat's store on its server can keep one here, since
 *  a browser has no local paste folder. */
export async function savePastedTextAsWebAgentSessionAttachment(args: {
  text: string
  runtimeEnvironmentId?: string | null
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
}): Promise<string> {
  if (!args.agentSessionAttachment || !args.runtimeEnvironmentId) {
    throw new Error('Pasted text can only be attached to a chat on a server here.')
  }
  return saveClipboardImageAsWebAgentSessionAttachment(
    await blobToBase64(new Blob([args.text], { type: 'text/plain' })),
    { ...args.agentSessionAttachment, environmentId: args.runtimeEnvironmentId },
    agentSessionPastedTextName(Date.now(), createBrowserUuid())
  )
}
