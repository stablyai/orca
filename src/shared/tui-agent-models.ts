import type { TuiAgent } from './types'

/** A model the user can pick for an agent. `flag` is the CLI option the agent
 *  uses to select a model (almost always `--model`); `models` is a curated
 *  suggestion list for the picker dropdown. An empty `models` still renders a
 *  free-text-only picker — the flag is known, so a typed value is injected
 *  correctly. */
export type TuiAgentModelInfo = {
  flag: string
  models: readonly string[]
}

/** Per-agent model flags. Intentionally conservative: only agents whose model
 *  flag is documented and stable are listed, so Orca never injects a wrong flag.
 *  Agents absent here simply hide the per-automation model field — users can
 *  still pass `--model <x>` through the CLI-args field for those. */
export const TUI_AGENT_MODELS: Partial<Record<TuiAgent, TuiAgentModelInfo>> = {
  claude: { flag: '--model', models: ['opus', 'sonnet', 'haiku'] },
  codex: { flag: '--model', models: ['gpt-5', 'gpt-5-codex'] },
  gemini: { flag: '--model', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  aider: { flag: '--model', models: [] }
}

export function getAgentModelInfo(agent: TuiAgent): TuiAgentModelInfo | null {
  return TUI_AGENT_MODELS[agent] ?? null
}

/** Whether the per-automation model field should be offered for this agent. */
export function agentSupportsModelSelection(agent: TuiAgent): boolean {
  return getAgentModelInfo(agent) !== null
}

function argContainsFlag(args: string, flag: string): boolean {
  // Why: match the flag as a whole token so `--model` does not also match a
  // hypothetical `--model-foo`, and so a value containing the substring is safe.
  const pattern = new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(=|\\s|$)`)
  return pattern.test(args)
}

/** Append the agent's model flag to its launch args. No-ops when the agent has
 *  no known flag, the model is blank, or the args already set that flag (an
 *  explicit user-typed `--model` in launchArgs wins over the picker). */
export function applyAgentModelToArgs(
  agent: TuiAgent,
  args: string,
  model: string | null | undefined
): string {
  const trimmedModel = (model ?? '').trim()
  if (!trimmedModel) {
    return args
  }
  const info = getAgentModelInfo(agent)
  if (!info) {
    return args
  }
  if (argContainsFlag(args, info.flag)) {
    return args
  }
  const base = args.trim()
  const suffix = `${info.flag} ${trimmedModel}`
  return base ? `${base} ${suffix}` : suffix
}
