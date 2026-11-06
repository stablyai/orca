import { agentImagePasteWrites } from './agent-image-paste'
import { agentImagePastePath } from './agent-image-paste-path'
import { buildNativeChatImagePasteBytes } from './native-chat/input/native-chat-paste-bytes'

/** How long an agent TUI takes to turn pasted image paths into attachments before text follows. */
export const AGENT_IMAGE_ATTACHMENT_SETTLE_MS = 300

/** Each image as a terminal image paste in the agent's own path framing, written before any text. */
export function agentImageAttachmentPastes(
  agent: string | null | undefined,
  imagePaths: readonly string[],
  followedByText: boolean
): string[] {
  return agentImagePasteWrites(
    agent,
    imagePaths.map((path) => buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))),
    followedByText
  )
}
