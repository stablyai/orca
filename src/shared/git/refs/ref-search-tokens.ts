export function getRefSearchTokens(query: string): string[] {
  return query.split('/').filter((token) => token.length > 0)
}
