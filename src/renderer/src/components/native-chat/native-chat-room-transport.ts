export function literalRoomTransportText(text: string): string | null {
  const trimmed = text.replace(/^[\p{Cc}\s]+/u, '')
  return trimmed.startsWith('<orca-room-delivery') ||
    trimmed.trim() === '<orca-room-silent />' ||
    trimmed.includes('<orca-room-recipients>')
    ? trimmed
    : null
}
