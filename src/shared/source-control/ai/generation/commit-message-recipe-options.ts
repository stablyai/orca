import { findOptionOccurrence } from '../../../command-option-occurrence'
import { compactRecipeOptions, findRecipeOption } from './commit-message-generation-options'

export function taskPolicyRecipeArgs(agent: string, args: string[]): string[] {
  if (agent === 'jcode') {
    return compactRecipeOptions(args, ['--tool-profile', '--tools'])
  }
  if (agent === 'codex') {
    const result = compactRecipeOptions(args, ['--sandbox', '-s']).filter(
      (token) =>
        !['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto'].includes(token)
    )
    let option = findOptionOccurrence(result, ['--enable'], true)
    while (option) {
      const next = option.index + option.consumed
      if (option.value === 'apps' || option.value === 'plugins') {
        result.splice(option.index, option.consumed)
        option = findOptionOccurrence(result, ['--enable'], true, [], option.index)
      } else {
        option = findOptionOccurrence(result, ['--enable'], true, [], next)
      }
    }
    return result
  }
  if (agent !== 'copilot') {
    return args
  }
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === '--') {
      return [...result, ...args.slice(index)]
    }
    if (token.startsWith('--available-tools=')) {
      continue
    }
    if (token === '--available-tools') {
      while (args[index + 1] !== undefined && !args[index + 1].startsWith('-')) {
        index++
      }
    } else {
      result.push(token)
    }
  }
  return result
}

export function codexRecipeConfigArgs(args: string[]): string[] {
  const valueOptions = [
    '-c',
    '--config',
    '-p',
    '--profile',
    '--profile-v2',
    '-C',
    '--cd',
    '--enable',
    '--disable',
    '--local-provider'
  ]
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const option = findOptionOccurrence(args, valueOptions, true, [], index)
    if (!option) {
      break
    }
    result.push(...args.slice(option.index, option.index + option.consumed))
    index = option.index + option.consumed - 1
  }
  return result
}

function applyRecipeOptionOverride(args: {
  generatedArgs: string[]
  recipeArgs: string[]
  aliases: readonly string[]
  valueOptions: readonly string[]
}): { generatedArgs: string[]; recipeArgs: string[] } {
  const recipeOption = findRecipeOption(args.recipeArgs, args.aliases, args.valueOptions)
  const generatedOption = findRecipeOption(
    args.generatedArgs,
    args.aliases,
    args.valueOptions,
    0,
    false
  )
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

/** User recipe args outrank override prefixes, which outrank generated singleton values. */
export function applySingletonOptionOverrides(args: {
  generatedArgs: string[]
  prefixArgs: string[]
  recipeArgs: string[]
  singletonOptions: readonly (readonly string[])[]
  valueOptions: readonly string[]
}): {
  generatedArgs: string[]
  prefixArgs: string[]
  recipeArgs: string[]
  nativePrefixArgs: string[]
  nativePrefixOptions: string[]
} {
  let generatedArgs = args.generatedArgs
  let prefixArgs = args.prefixArgs
  let recipeArgs = args.recipeArgs
  const claimed: (readonly string[])[] = []

  for (const aliases of args.singletonOptions) {
    recipeArgs = compactRecipeOptions(recipeArgs, aliases, args.valueOptions, true)
    prefixArgs = compactRecipeOptions(prefixArgs, aliases, args.valueOptions, true)
    const recipeOption = findRecipeOption(recipeArgs, aliases, args.valueOptions)
    const prefixOption = findRecipeOption(prefixArgs, aliases, args.valueOptions)
    const prefixHasTerminator =
      findOptionOccurrence(prefixArgs, ['--'], false, args.valueOptions, 0, false) !== null
    if (recipeOption && !prefixHasTerminator) {
      prefixArgs = compactRecipeOptions(prefixArgs, aliases, args.valueOptions)
    } else if (prefixOption && !prefixHasTerminator) {
      claimed.push(aliases)
      const generatedOption = findRecipeOption(generatedArgs, aliases, args.valueOptions, 0, false)
      if (generatedOption) {
        generatedArgs = [
          ...generatedArgs.slice(0, generatedOption.index),
          ...generatedArgs.slice(generatedOption.index + generatedOption.consumed)
        ]
      }
      continue
    }
    const withRecipe = applyRecipeOptionOverride({
      generatedArgs,
      recipeArgs,
      aliases,
      valueOptions: args.valueOptions
    })
    generatedArgs = withRecipe.generatedArgs
    recipeArgs = withRecipe.recipeArgs
  }

  // Claims refer to the compacted prefix, after precedence has selected the effective inputs.
  const spans = claimed.map((aliases) => findRecipeOption(prefixArgs, aliases, args.valueOptions)!)
  const nativePrefixOptions = spans.flatMap((option) =>
    prefixArgs.slice(option.index, option.index + option.consumed)
  )
  const nativePrefixArgs = [...prefixArgs]
  for (const option of spans.sort((left, right) => right.index - left.index)) {
    nativePrefixArgs.splice(option.index, option.consumed)
  }
  return { generatedArgs, prefixArgs, recipeArgs, nativePrefixArgs, nativePrefixOptions }
}
