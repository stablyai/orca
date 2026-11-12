export type GenerationArgument = string | { value: string; literal: true }

export function generationArgumentText(argument: GenerationArgument): string {
  return typeof argument === 'string' ? argument : argument.value
}

/** Task text cannot become an option name or terminator while recipe options are composed. */
export function generationOptionTokens(args: readonly GenerationArgument[]): string[] {
  return args.map((argument) => (typeof argument === 'string' ? argument : 'literal-task-text'))
}
