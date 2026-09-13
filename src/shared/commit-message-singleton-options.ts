export const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]

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

function findOptionOccurrence(
  tokens: string[],
  aliases: readonly string[],
  stopAtTerminator: boolean
): { index: number; consumed: number } | null {
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
    return { index, consumed: consumesNext ? 2 : 1 }
  }
  return null
}

function applyRecipeOptionOverride(args: {
  generatedArgs: string[]
  recipeArgs: string[]
  aliases: readonly string[]
}): { generatedArgs: string[]; recipeArgs: string[] } {
  const recipeOption = findOptionOccurrence(args.recipeArgs, args.aliases, true)
  const generatedOption = findOptionOccurrence(args.generatedArgs, args.aliases, false)
  if (!recipeOption || !generatedOption) {
    return { generatedArgs: args.generatedArgs, recipeArgs: args.recipeArgs }
  }

  const overrideTokens = args.recipeArgs.slice(
    recipeOption.index,
    recipeOption.index + recipeOption.consumed
  )
  return {
    generatedArgs: [
      ...args.generatedArgs.slice(0, generatedOption.index),
      ...overrideTokens,
      ...args.generatedArgs.slice(generatedOption.index + generatedOption.consumed)
    ],
    recipeArgs: [
      ...args.recipeArgs.slice(0, recipeOption.index),
      ...args.recipeArgs.slice(recipeOption.index + recipeOption.consumed)
    ]
  }
}

export function removeAllOptionOccurrences(
  tokens: string[],
  aliases: readonly string[]
): string[] {
  let result = tokens
  while (true) {
    const found = findOptionOccurrence(result, aliases, true)
    if (!found) {
      return result
    }
    result = [...result.slice(0, found.index), ...result.slice(found.index + found.consumed)]
  }
}

/** Drops every occurrence after the first, so a user who types the same singleton
 *  twice in one field still gets a single flag rather than a rejected argv. */
function keepFirstOptionOccurrence(tokens: string[], aliases: readonly string[]): string[] {
  let result = tokens
  while (true) {
    const first = findOptionOccurrence(result, aliases, true)
    if (!first) {
      return result
    }
    const tail = result.slice(first.index + first.consumed)
    const duplicate = findOptionOccurrence(tail, aliases, true)
    if (!duplicate) {
      return result
    }
    const offset = first.index + first.consumed
    result = [
      ...result.slice(0, offset + duplicate.index),
      ...result.slice(offset + duplicate.index + duplicate.consumed)
    ]
  }
}

/** Removes generated singleton options shadowed by user input. Recipe args
 *  outrank a command-override prefix, which outranks Orca's generated value. */
export function applySingletonOptionOverrides(args: {
  generatedArgs: string[]
  prefixArgs: string[]
  recipeArgs: string[]
  singletonOptions: readonly (readonly string[])[]
}): { generatedArgs: string[]; prefixArgs: string[]; recipeArgs: string[] } {
  let generatedArgs = args.generatedArgs
  let prefixArgs = args.prefixArgs
  let recipeArgs = args.recipeArgs

  for (const aliases of args.singletonOptions) {
    recipeArgs = keepFirstOptionOccurrence(recipeArgs, aliases)
    prefixArgs = keepFirstOptionOccurrence(prefixArgs, aliases)
    const recipeOption = findOptionOccurrence(recipeArgs, aliases, true)
    const prefixOption = findOptionOccurrence(prefixArgs, aliases, true)
    const prefixHasTerminator = prefixArgs.includes('--')
    if (recipeOption && !prefixHasTerminator) {
      prefixArgs = removeAllOptionOccurrences(prefixArgs, aliases)
    } else if (prefixOption && !prefixHasTerminator) {
      const generatedOption = findOptionOccurrence(generatedArgs, aliases, false)
      if (generatedOption) {
        generatedArgs = [
          ...generatedArgs.slice(0, generatedOption.index),
          ...generatedArgs.slice(generatedOption.index + generatedOption.consumed)
        ]
      }
      continue
    }
    const withRecipe = applyRecipeOptionOverride({ generatedArgs, recipeArgs, aliases })
    generatedArgs = withRecipe.generatedArgs
    recipeArgs = withRecipe.recipeArgs
  }

  return { generatedArgs, prefixArgs, recipeArgs }
}
