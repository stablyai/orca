import { memoizeStringResult } from '../../collections/string-result-cache'
import { sha256 } from '../../hashing/sha256'

/** Legacy tab id of chats opened before slot ids were minted. */
export function structuredAgentSessionTabId(sessionId: string): string {
  return `structured-agent-session-${sessionId}`
}

// Why: callers walk every live chat, and a FIFO smaller than that set misses on every pass.
const MAX_MEMOIZED_PANE_LEAVES = 32_768
export const structuredAgentSessionPaneLeaf = memoizeStringResult((sessionId: string): string => {
  const bytes = sha256(new TextEncoder().encode(sessionId))
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}, MAX_MEMOIZED_PANE_LEAVES)

/** The tab part of a chat's pane key: a conversation address, not the id of any tab it shows in. */
export function chatPaneAddressTabId(sessionId: string): string {
  return structuredAgentSessionTabId(sessionId)
}

/** A chat's pane address follows its conversation, never the tab it sits in, so status, attention
 *  and worker links survive the chat moving tabs and match on every client and host. */
export const chatPaneKey = memoizeStringResult(
  (sessionId: string): string =>
    `${chatPaneAddressTabId(sessionId)}:${structuredAgentSessionPaneLeaf(sessionId)}`,
  MAX_MEMOIZED_PANE_LEAVES
)

export const CHAT_PANE_ADDRESS_PREFIX = chatPaneAddressTabId('')

/** The session a chat's pane key addresses, or null for any other pane key. */
export function chatPaneKeySessionId(paneKey: string): string | null {
  if (!paneKey.startsWith(CHAT_PANE_ADDRESS_PREFIX)) {
    return null
  }
  const separator = paneKey.lastIndexOf(':')
  const sessionId = paneKey.slice(CHAT_PANE_ADDRESS_PREFIX.length, separator)
  return separator > 0 && chatPaneKey(sessionId) === paneKey ? sessionId : null
}
