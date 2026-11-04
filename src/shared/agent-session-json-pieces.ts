export const AGENT_SESSION_JSON_PIECE_UNITS = 24 * 1024

export type AgentSessionJsonPiece = {
  json: string
  nextCursor: number | null
  total?: number
}

export function agentSessionJsonPiece(
  json: string,
  cursor = 0
): AgentSessionJsonPiece & { total: number } {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= json.length) {
    throw new Error('Invalid content cursor')
  }
  const end = Math.min(cursor + AGENT_SESSION_JSON_PIECE_UNITS, json.length)
  return {
    json: json.slice(cursor, end),
    nextCursor: end === json.length ? null : end,
    total: json.length
  }
}

export function createAgentSessionJsonAssembly(maxUnits: number, requireTotal = false) {
  const chunks: string[] = []
  let cursor = 0
  let total: number | undefined
  return {
    get cursor() {
      return cursor
    },
    accept(piece: AgentSessionJsonPiece): { value: unknown } | null {
      if (
        typeof piece.json !== 'string' ||
        piece.json.length === 0 ||
        piece.json.length > AGENT_SESSION_JSON_PIECE_UNITS
      ) {
        throw new Error('Invalid content piece')
      }
      if (requireTotal && piece.total === undefined) {
        throw new Error('Missing content length')
      }
      if (piece.total !== undefined) {
        if (
          !Number.isSafeInteger(piece.total) ||
          piece.total <= 0 ||
          piece.total > maxUnits ||
          (total !== undefined && total !== piece.total)
        ) {
          throw new Error('Invalid content length')
        }
        total = piece.total
      }
      const next = cursor + piece.json.length
      if (
        next > maxUnits ||
        (total !== undefined && next > total) ||
        (piece.nextCursor === null
          ? total !== undefined && next !== total
          : piece.nextCursor !== next || (total !== undefined && next >= total))
      ) {
        throw new Error('Invalid content cursor')
      }
      chunks.push(piece.json)
      cursor = next
      if (piece.nextCursor !== null) {
        return null
      }
      const joined = chunks.join('')
      const value: unknown = JSON.parse(joined)
      chunks.length = 0
      return { value }
    }
  }
}
