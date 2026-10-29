// Why a fixed prefix with UUID version 8: Claude mints v4 ids, so any process can recognize a side chat from its id alone.
const SIDE_CHAT_SESSION_ID_PREFIX = '05ca51de-'
const SIDE_CHAT_SESSION_ID_PATTERN =
  /^05ca51de-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createClaudeSideChatSessionId(randomUuid: string): string {
  const hex = randomUuid.replaceAll('-', '').toLowerCase()
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${SIDE_CHAT_SESSION_ID_PREFIX}${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Side chats never write a transcript, so their ids can be neither resumed nor forked. */
export function isClaudeSideChatSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && SIDE_CHAT_SESSION_ID_PATTERN.test(id)
}
