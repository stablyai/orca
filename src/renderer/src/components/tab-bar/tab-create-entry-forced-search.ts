export type ForcedSearchQuery = { forced: false; query: string } | { forced: true; query: string }

export function parseForcedSearchQuery(input: string): ForcedSearchQuery {
  if (!input.startsWith('?')) {
    return { forced: false, query: input.trim() }
  }
  return { forced: true, query: input.slice(1).trim() }
}
