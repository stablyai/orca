import type { CommandTokenSpan } from './commit-message-prompt'
import {
  argumentsSetOption,
  bypassFlagGroups,
  classifyTypedAgentPermissions,
  LAUNCH_GRAMMARS,
  optionTokens
} from './tui-agent-permission-args'
import {
  resolveAgentLaunchGrammar,
  tokenizeStartupCommand,
  type AgentLaunchTarget
} from './tui-agent-startup-shell'
import { YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import type { TuiAgent } from './tui-agent'

// Moves a permission bypass saved inline in an agent's Arguments or env out into its typed mode.

type FlagOccurrence = { start: number; end: number; words: string }

/** Every place these exact raw words stand as consecutive words in `spans`. */
function rawOccurrences(
  text: string,
  spans: readonly CommandTokenSpan[],
  rawSequence: readonly string[]
): FlagOccurrence[] {
  const found: FlagOccurrence[] = []
  for (let index = 0; index + rawSequence.length <= spans.length; index += 1) {
    const words = spans.slice(index, index + rawSequence.length)
    if (words.every((span, offset) => text.slice(span.start, span.end) === rawSequence[offset])) {
      found.push({
        start: spans[index].start,
        end: spans[index + rawSequence.length - 1].end,
        words: words.map((span) => `${span.start}:${span.end}`).join(' ')
      })
    }
  }
  return found
}

/**
 * The first place the flag's exact words stand as whole, unquoted, unescaped words under every
 * shell grammar; null when any grammar can't parse the text or reads them inside another word.
 * A cut then means the same under every shell, and a wrong call keeps the flag (more prompts).
 */
function findBypassFlag(text: string, rawFlag: readonly string[]): FlagOccurrence | null {
  const perGrammar: FlagOccurrence[][] = []
  for (const grammar of LAUNCH_GRAMMARS) {
    const tokens = optionTokens(text, grammar)
    if (!tokens.ok) {
      return null
    }
    perGrammar.push(rawOccurrences(text, tokens.spans, rawFlag))
  }
  const [first = [], ...others] = perGrammar
  return (
    first.find((hit) =>
      others.every((found) => found.some((other) => other.words === hit.words))
    ) ?? null
  )
}

/**
 * Whether every grammar reads the cut text as exactly its old words minus the flag's. Trimming the
 * gap can drop a space escaped by `\`, a backtick or `^`, gluing two words; such a cut is refused.
 */
function cutKeepsOtherWords(text: string, cut: string, hit: FlagOccurrence): boolean {
  return LAUNCH_GRAMMARS.every((grammar) => {
    const before = tokenizeStartupCommand(text, grammar)
    const after = tokenizeStartupCommand(cut, grammar)
    if (!before.ok || !after.ok) {
      return false
    }
    const kept = before.tokens.filter(
      (_, index) => before.spans[index].end <= hit.start || before.spans[index].start >= hit.end
    )
    return kept.length === after.tokens.length && kept.every((word, i) => word === after.tokens[i])
  })
}

/**
 * Cuts each option of the bypass flag out of the text. A companion option the user set to another
 * value stays theirs; if any other part is missing the flag never launched whole, so nothing is cut.
 */
function stripBypassFlag(agent: TuiAgent, args: string): string {
  let text = args
  for (const group of bypassFlagGroups(agent)) {
    let hit = findBypassFlag(text, group.rawTokens)
    const found = hit !== null
    while (hit) {
      const before = text.slice(0, hit.start).trimEnd()
      const after = text.slice(hit.end).trimStart()
      const cut = before && after ? `${before} ${after}` : before || after
      if (!cutKeepsOtherWords(text, cut, hit)) {
        return args
      }
      text = cut
      hit = findBypassFlag(text, group.rawTokens)
    }
    const userSetsIt = LAUNCH_GRAMMARS.every((grammar) =>
      argumentsSetOption(text, group.option, [grammar])
    )
    if (!found && (group.permission || !userSetsIt)) {
      return args
    }
  }
  return text
}

/**
 * The text with the canonical bypass flag cut out, or unchanged when the rest would still set
 * permissions under some shell (a launch there would add no flag back, so cutting would lose it).
 */
export function cutTuiAgentBypassFlag(agent: TuiAgent, args: string | null | undefined): string {
  const original = args?.trim() ?? ''
  const rest = stripBypassFlag(agent, original)
  const restSetsNothing = LAUNCH_GRAMMARS.every(
    (grammar) => classifyTypedAgentPermissions(agent, { args: rest }, grammar).kind === 'none'
  )
  return rest !== original && restSetsNothing ? rest : original
}

/**
 * Splits the bypass flag out of arguments saved with it inline, keeping the rest's quoting. Text
 * left whole reads as bypass when it holds the flag or bypasses at `target` (an alias like `-y`).
 */
export function liftTuiAgentBypassArgs(
  agent: TuiAgent,
  args: string | null | undefined,
  target: AgentLaunchTarget
): { bypass: boolean; extraArgs: string } {
  const original = args?.trim() ?? ''
  const extraArgs = cutTuiAgentBypassFlag(agent, original)
  const bypass =
    extraArgs !== original ||
    stripBypassFlag(agent, original) !== original ||
    classifyTypedAgentPermissions(agent, { args: original }, resolveAgentLaunchGrammar(target))
      .kind === 'bypass'
  return { bypass, extraArgs }
}

/** Splits this agent's env-driven permission bypass out of an environment record. */
export function liftTuiAgentBypassEnv(
  agent: TuiAgent,
  env: Record<string, string> | null | undefined
): { bypass: boolean; extraEnv: Record<string, string> } {
  const extraEnv = { ...env }
  const bypassEnv = YOLO_TUI_AGENT_ENV[agent]
  if (!bypassEnv || !Object.entries(bypassEnv).every(([name, value]) => extraEnv[name] === value)) {
    return { bypass: false, extraEnv }
  }
  for (const name of Object.keys(bypassEnv)) {
    delete extraEnv[name]
  }
  return { bypass: true, extraEnv }
}
