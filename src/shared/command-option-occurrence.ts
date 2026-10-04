function matchesOption(token: string, aliases: readonly string[]): boolean {
  return aliases.some(
    (alias) =>
      token === alias ||
      token.startsWith(`${alias}=`) ||
      (alias.startsWith('-') &&
        !alias.startsWith('--') &&
        token.startsWith(alias) &&
        token.length > alias.length)
  )
}

export function findOptionOccurrence(
  tokens: readonly string[],
  aliases: readonly string[],
  stopAtTerminator: boolean
): { index: number; consumed: number; value?: string } | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (stopAtTerminator && token === '--') {
      break
    }
    if (!matchesOption(token, aliases)) {
      continue
    }
    const nextToken = tokens[index + 1]
    const consumesNext =
      aliases.includes(token) && nextToken !== undefined && !nextToken.startsWith('-')
    const alias = aliases.find((name) => matchesOption(token, [name]))
    const value = consumesNext
      ? nextToken
      : alias && token !== alias
        ? token.slice(alias.length + (token[alias.length] === '=' ? 1 : 0))
        : undefined
    return { index, consumed: consumesNext ? 2 : 1, value }
  }
  return null
}
