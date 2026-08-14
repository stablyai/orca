export function literalRoomTransportText(text: string): string | null {
  const trimmed = text.replace(/^[\p{Cc}\s]+/u, '')
  return trimmed.startsWith('<orca-room-delivery') ||
    trimmed.trim() === '<orca-room-silent />' ||
    trimmed.includes('<orca-room-recipients>')
    ? trimmed
    : null
}

export function visibleRoomReplyText(text: string): string {
  return text.replace(/\n?<orca-room-(?:recipients|silent)\b[\s\S]*$/u, '').trimEnd()
}
