import { isHeldAgentPromptDraft } from '../../../../../../../shared/agent-launch/startup/agent-prompt-injection'

/** How often Enter re-reads the input line while the paste is still arriving. */
export const NATIVE_CHAT_PASTE_LANDED_POLL_MS = 100
/** Beyond the usual Enter delay; after it Enter goes anyway, as before this check existed. */
export const NATIVE_CHAT_PASTE_LANDED_MAX_WAIT_MS = 5000

// Claude shows a long paste as this label instead of its text.
const CLAUDE_COLLAPSED_PASTE = /^(?:\[Pasted text #\d+(?: \+\d+ lines)?\]\s*)+$/

/** True once the agent's input line shows the pasted message, so Enter cannot land mid-paste. */
export function nativeChatInputShowsPastedText(
  line: string | null | undefined,
  text: string
): boolean {
  if (!line) {
    return false
  }
  return isHeldAgentPromptDraft(line, text, 0) || CLAUDE_COLLAPSED_PASTE.test(line.trim())
}
