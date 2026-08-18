export function agentArgOptionTokens(tokens: readonly string[]): readonly string[] {
  const terminator = tokens.indexOf('--')
  return terminator === -1 ? tokens : tokens.slice(0, terminator)
}

export function removeAgentArgOption(
  tokens: readonly string[],
  aliases: readonly string[]
): string[] {
  const result: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      result.push(...tokens.slice(index))
      break
    }
    const exact = aliases.includes(token)
    const matched = aliases.some(
      (alias) =>
        token.startsWith(`${alias}=`) ||
        (alias.startsWith('-') &&
          !alias.startsWith('--') &&
          token.startsWith(alias) &&
          token.length > alias.length)
    )
    if (!exact && !matched) {
      result.push(token)
      continue
    }
    if (exact && tokens[index + 1] && !tokens[index + 1].startsWith('-')) {
      index += 1
    }
  }
  return result
}
