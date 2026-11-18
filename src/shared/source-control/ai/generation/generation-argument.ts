export type GenerationArgument = string | { value: string; literal: true }

export function generationArgumentText(argument: GenerationArgument): string {
  return typeof argument === 'string' ? argument : argument.value
}

/** Task text cannot become an option name or terminator while recipe options are composed. */
export function generationOptionTokens(args: readonly GenerationArgument[]): string[] {
  return args.map((argument) => (typeof argument === 'string' ? argument : 'literal-task-text'))
}

export function insertAdditionalAgentArgs(args: {
  baseArgs: GenerationArgument[]
  agentArgs: GenerationArgument[]
  promptDelivery: 'argv' | 'stdin' | 'file'
  prompt?: GenerationArgument
  /** Built-in argv, whose `--` before the prompt ends options; a custom `--` may pass args through a wrapper. */
  builtIn?: boolean
}): GenerationArgument[] {
  if (!args.agentArgs.length) {
    return args.baseArgs
  }
  const promptPlaceholderIndex = args.baseArgs.lastIndexOf('{prompt}')
  if (promptPlaceholderIndex !== -1) {
    const merged = [...args.baseArgs]
    merged.splice(promptPlaceholderIndex, 0, ...args.agentArgs)
    return merged
  }
  if (
    args.promptDelivery === 'argv' &&
    args.prompt !== undefined &&
    generationArgumentText(args.prompt).length > 0 &&
    args.baseArgs.at(-1) === args.prompt
  ) {
    const insertAt = args.builtIn && args.baseArgs.at(-2) === '--' ? -2 : -1
    return [
      ...args.baseArgs.slice(0, insertAt),
      ...args.agentArgs,
      ...args.baseArgs.slice(insertAt)
    ]
  }
  return [...args.baseArgs, ...args.agentArgs]
}
