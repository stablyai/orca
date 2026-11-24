/** A chat tab slot id minted once, never derived from the chat's session id. New chats don't mint
 *  one yet; readers accept it so tabs that carry one resolve to their chat. */
const SLOT_TAB_PREFIX = 'chat-tab-'

export function isAgentSessionSlotTabId(tabId: string): boolean {
  return tabId.startsWith(SLOT_TAB_PREFIX) && tabId.length > SLOT_TAB_PREFIX.length
}
