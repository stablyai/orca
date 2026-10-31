let holderOrdinal = 0

export function structuredAgentSessionHolderId(surface: string): string {
  holderOrdinal += 1
  return `${surface}:${holderOrdinal}`
}
