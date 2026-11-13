import { findOptionOccurrence } from '../../command-option-occurrence'

/** OpenCode 1 has no --standalone/--server; a copied session must not inherit OpenCode 2's private-server mode. */
export function dropOpenCodeV1ServerModeArgs(tokens: readonly string[]): readonly string[] {
  const kept: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      kept.push(...tokens.slice(index))
      break
    }
    if (token === '--standalone') {
      continue
    }
    const server = findOptionOccurrence(tokens, ['--server'], true, [], index, 'required')
    if (server && server.index === index) {
      index += server.consumed - 1
      continue
    }
    kept.push(token)
  }
  return kept
}
