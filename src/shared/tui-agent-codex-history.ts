import type { TuiAgent } from './types'

function findUnquotedOptionTerminator(value: string): number {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === "'") {
      if (char === "'") {
        quote = null
      }
      continue
    }
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (
      char === '-' &&
      value[index + 1] === '-' &&
      (index === 0 || /\s/.test(value[index - 1] as string)) &&
      (index + 2 === value.length || /\s/.test(value[index + 2] as string))
    ) {
      return index
    }
  }
  return -1
}

export function withCodexHistoryPersistenceDisabled(args: {
  agent: TuiAgent
  baseCommand: string
}): string {
  if (args.agent !== 'codex') {
    return args.baseCommand
  }
  // Why: command overrides can be `npx codex` or absolute paths that bypass
  // Orca's shell function/macro named `codex`; keep the safety in argv too.
  const override = '-c history.persistence=none'
  const terminatorIndex = findUnquotedOptionTerminator(args.baseCommand)
  if (terminatorIndex === -1) {
    return `${args.baseCommand} ${override}`
  }
  return `${args.baseCommand.slice(0, terminatorIndex)}${override} ${args.baseCommand.slice(terminatorIndex)}`
}
