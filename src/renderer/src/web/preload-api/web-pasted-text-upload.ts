import {
  agentSessionPastedTextName,
  type AgentSessionAttachmentClipboardTarget
} from '../../../../shared/agent-session/agent-session-attachments'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { holdBrowserAttachmentFiles } from '@/lib/browser-attachment-files'
import { blobToBase64 } from '@/lib/clipboard/images/image-blob-png'
import { saveClipboardImageAsWebAgentSessionAttachment } from './web-agent-session-attachment-upload'

/** A long text paste saved as a file: only a chat's store on its server can keep one here, since
 *  a browser has no local paste folder. */
export async function savePastedTextAsWebAgentSessionAttachment(args: {
  text: string
  runtimeEnvironmentId?: string | null
  agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
}): Promise<string> {
  if (!args.agentSessionAttachment || !args.runtimeEnvironmentId) {
    return holdBrowserAttachmentFiles([
      new File([args.text], agentSessionPastedTextName(Date.now(), createBrowserUuid()), {
        type: 'text/plain'
      })
    ])[0]
  }
  return saveClipboardImageAsWebAgentSessionAttachment(
    await blobToBase64(new Blob([args.text], { type: 'text/plain' })),
    { ...args.agentSessionAttachment, environmentId: args.runtimeEnvironmentId },
    agentSessionPastedTextName(Date.now(), createBrowserUuid())
  )
}
