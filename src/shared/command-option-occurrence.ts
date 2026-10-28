function matchesOption(token: string, aliases: readonly string[]): boolean {
  return aliases.some(
    (alias) =>
      token === alias ||
      (alias !== '--' && token.startsWith(`${alias}=`)) ||
      (alias.startsWith('-') &&
        !alias.startsWith('--') &&
        token.startsWith(alias) &&
        token.length > alias.length)
  )
}

export function findOptionOccurrence(
  tokens: readonly string[],
  aliases: readonly string[],
  stopAtTerminator: boolean,
  valueOptions: readonly string[] = [],
  startIndex = 0,
  /** False keeps the next token; 'required' consumes even a dash-leading operand. */
  takesValue: boolean | 'required' = true
): { index: number; consumed: number; value?: string } | null {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (stopAtTerminator && token === '--') {
      break
    }
    if (!matchesOption(token, aliases)) {
      // Required option values can look like flags, including `--`.
      if (valueOptions.includes(token)) {
        index += 1
      }
      continue
    }
    const nextToken = tokens[index + 1]
    const consumesNext =
      takesValue &&
      aliases.includes(token) &&
      nextToken !== undefined &&
      (takesValue === 'required' || !nextToken.startsWith('-'))
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
