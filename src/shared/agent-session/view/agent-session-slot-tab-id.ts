/** A chat tab slot minted once at creation; it never derives from the chat's session id. */
const SLOT_TAB_PREFIX = 'chat-tab-'

export function mintAgentSessionSlotTabId(randomUuid: () => string): string {
  return `${SLOT_TAB_PREFIX}${randomUuid()}`
}

export function isAgentSessionSlotTabId(tabId: string): boolean {
  return tabId.startsWith(SLOT_TAB_PREFIX) && tabId.length > SLOT_TAB_PREFIX.length
}
