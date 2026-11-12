/** Reads a Claude argv with the tables in `claude-cli-option-grammar`, the way the CLI assigns
 *  tokens, and fails safe to `unclassified` on anything the tables do not positively recognize. */

import {
  NON_SESSION_SUBCOMMANDS,
  ROOT_OPTIONS,
  SESSION_SUBCOMMANDS,
  type ClaudeArgvKind,
  type OptionEffect,
  type OptionSpec,
  type OptionTable
} from './claude-cli-option-grammar'

export type { ClaudeArgvKind } from './claude-cli-option-grammar'

function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-')
}

type OptionScan = {
  operands: string[]
  effects: Set<OptionEffect>
  /** Where the scan stopped: past the last token, or at the operand `stopAtOperand` accepted. */
  next: number
}

/**
 * Walks `args` from `start` under `table`, the way commander assigns tokens. Returns null when a
 * token is not positively recognized. `stopAtOperand` ends the scan at an operand it accepts.
 */
function scanOptions(
  args: readonly string[],
  start: number,
  table: OptionTable,
  stopAtOperand?: (operand: string, operandsSoFar: number) => boolean
): OptionScan | null {
  const operands: string[] = []
  const effects = new Set<OptionEffect>()
  let variadicOpen = false
  let index = start

  const accept = (spec: OptionSpec, value: string | null): boolean => {
    if (value !== null && spec.choices && !spec.choices.includes(value)) {
      return false
    }
    if (spec.effect) {
      effects.add(spec.effect)
    }
    return true
  }
  /** An option written as its own token: its value, if any, is the next token. */
  const acceptWithNextToken = (spec: OptionSpec): boolean => {
    let value: string | null = null
    if (spec.arity === 'required' || spec.arity === 'variadic') {
      // Why reject an option-like value: the CLI would consume it, but a title cannot tell
      // `--name --help` from a mistyped launch, so it is not a positive reading.
      if (index >= args.length || args[index].startsWith('-')) {
        return false
      }
      value = args[index]
      index += 1
    } else if (spec.arity === 'optional' && index < args.length && !looksLikeOption(args[index])) {
      value = args[index]
      index += 1
    }
    variadicOpen = spec.arity === 'variadic'
    return accept(spec, value)
  }
  /** Combined short flags: each leading flag stands alone, and the first value-taking one takes
   *  the rest of the token (`-cd`, `-ndoctor`, `-dhooks`), or the next token when it is last. */
  const acceptShortCluster = (cluster: string): boolean => {
    for (let offset = 1; offset < cluster.length; offset += 1) {
      const spec = table.get(`-${cluster[offset]}`)
      if (!spec) {
        return false
      }
      const rest = cluster.slice(offset + 1)
      if (spec.arity !== 'flag') {
        return rest ? accept(spec, rest) : acceptWithNextToken(spec)
      }
      if (!accept(spec, null)) {
        return false
      }
    }
    return true
  }

  while (index < args.length) {
    const arg = args[index]
    index += 1
    if (arg === '--') {
      // Ends option parsing only: the operands after it still name a subcommand or a prompt.
      for (; index < args.length; index += 1) {
        if (stopAtOperand?.(args[index], operands.length)) {
          return { operands, effects, next: index }
        }
        operands.push(args[index])
      }
      break
    }
    if (variadicOpen && !looksLikeOption(arg)) {
      continue
    }
    variadicOpen = false
    if (!looksLikeOption(arg)) {
      if (stopAtOperand?.(arg, operands.length)) {
        return { operands, effects, next: index - 1 }
      }
      operands.push(arg)
      continue
    }
    const spec = table.get(arg)
    if (spec) {
      if (!acceptWithNextToken(spec)) {
        return null
      }
      continue
    }
    if (!arg.startsWith('--')) {
      if (!acceptShortCluster(arg)) {
        return null
      }
      continue
    }
    // `--opt=value`; a variadic option given this way takes no further tokens.
    const eq = arg.indexOf('=')
    const inline = eq === -1 ? undefined : table.get(arg.slice(0, eq))
    if (!inline || inline.arity === 'flag' || !accept(inline, arg.slice(eq + 1))) {
      return null
    }
  }
  return { operands, effects, next: index }
}

function kindFromEffects(effects: ReadonlySet<OptionEffect>): ClaudeArgvKind {
  if (effects.has('informational')) {
    return 'informational'
  }
  if (effects.has('headless')) {
    return 'headless'
  }
  return effects.has('non-foreground') ? 'non-foreground' : 'interactive-session'
}

/** Classifies the arguments after the `claude` executable. */
export function classifyClaudeArgv(args: readonly string[]): ClaudeArgvKind {
  const isSubcommand = (operand: string, operandsSoFar: number): boolean =>
    operandsSoFar === 0 &&
    (NON_SESSION_SUBCOMMANDS.has(operand) || SESSION_SUBCOMMANDS.has(operand))
  const root = scanOptions(args, 0, ROOT_OPTIONS, isSubcommand)
  if (!root) {
    return 'unclassified'
  }
  if (root.next >= args.length) {
    // No subcommand: every operand is the prompt.
    return kindFromEffects(root.effects)
  }
  const name = args[root.next]
  if (NON_SESSION_SUBCOMMANDS.has(name)) {
    return 'non-session-subcommand'
  }
  const subcommand = SESSION_SUBCOMMANDS.get(name)
  const rest = subcommand && scanOptions(args, root.next + 1, subcommand.options)
  if (!subcommand || !rest) {
    return 'unclassified'
  }
  const effects = new Set([...root.effects, ...rest.effects])
  // Help and the other exits win before the subcommand reads its operands.
  if (effects.size > 0) {
    return kindFromEffects(effects)
  }
  const count = rest.operands.length
  return count >= subcommand.operands.min && count <= subcommand.operands.max
    ? 'interactive-session'
    : 'unclassified'
}
