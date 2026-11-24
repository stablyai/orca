import { PI_THINKING_LEVELS } from '../../agent-session/options/reconciliation/structured-agent-session-effective-effort'
import type { TuiAgent } from '../catalog/tui-agent'

export type ExtraAgentArgKind = 'model' | 'effort' | 'repeatable' | 'flag' | 'value'

export type ExtraAgentArgOption = {
  kind: ExtraAgentArgKind
  aliases: readonly string[]
  /** Accepts only values with this prefix, e.g. Codex's `-c model_reasoning_effort=`. */
  valuePrefix?: string
  /** Accepts only these values. */
  values?: readonly string[]
  /** The CLI reads only `--flag value`, so `--flag=value` is split. */
  separateValue?: true
}

const MODEL_OPTION = { kind: 'model', aliases: ['--model'] } as const
const MODEL_OR_M_OPTION = { kind: 'model', aliases: ['-m', '--model'] } as const

// Allowlist paired-client extras so they cannot alter permissions or Orca-owned prompt/resume/cwd/print/config/MCP flags.
export const EXTRA_AGENT_ARG_OPTIONS: Partial<Record<TuiAgent, readonly ExtraAgentArgOption[]>> = {
  antigravity: [
    MODEL_OPTION,
    { kind: 'effort', aliases: ['--effort'] },
    { kind: 'flag', aliases: ['--remote-agent'] },
    { kind: 'flag', aliases: ['--remote-control'] },
    { kind: 'flag', aliases: ['--new-project'] },
    { kind: 'value', aliases: ['--project'] },
    { kind: 'value', aliases: ['--agent'] },
    { kind: 'repeatable', aliases: ['--add-dir'] }
  ],
  claude: [
    MODEL_OPTION,
    { kind: 'effort', aliases: ['--effort'] },
    { kind: 'repeatable', aliases: ['--add-dir'] }
  ],
  codex: [
    MODEL_OR_M_OPTION,
    { kind: 'effort', aliases: ['-c', '--config'], valuePrefix: 'model_reasoning_effort=' }
  ],
  codebuddy: [MODEL_OPTION, { kind: 'effort', aliases: ['--effort'] }],
  // Cursor composes effort into the model id, so only the model is a flag.
  cursor: [MODEL_OR_M_OPTION],
  grok: [MODEL_OR_M_OPTION, { kind: 'effort', aliases: ['--effort', '--reasoning-effort'] }],
  omp: [MODEL_OPTION],
  pi: [
    { ...MODEL_OPTION, separateValue: true },
    { kind: 'effort', aliases: ['--thinking'], values: PI_THINKING_LEVELS, separateValue: true }
  ]
}

export function supportsExtraAgentArgs(agent: TuiAgent): boolean {
  return EXTRA_AGENT_ARG_OPTIONS[agent] !== undefined
}

export function getExtraAgentArgsPlaceholder(agent: TuiAgent): string {
  return (EXTRA_AGENT_ARG_OPTIONS[agent] ?? [])
    .map((option) => {
      if (option.kind === 'flag') {
        return option.aliases[0]
      }
      const value =
        option.kind === 'model'
          ? agent === 'claude'
            ? 'opus'
            : 'model-id'
          : option.kind === 'effort'
            ? 'high'
            : option.kind === 'value'
              ? option.aliases[0].replace(/^-+/, '')
              : 'docs'
      return `${option.aliases[0]} ${option.valuePrefix ?? ''}${value}`
    })
    .join(' ')
}

// One English table: `error` stays English for older readers; the renderer translates by code.
export const EXTRA_AGENT_ARGS_FAILURE_COPY = {
  unsupportedAgent: "Extra arguments aren't supported for this agent yet.",
  tooLarge: 'Extra arguments must be 4 KB or less.',
  controlCharacters: 'Extra arguments cannot contain control characters or line breaks.',
  invalid: 'Extra arguments are invalid: {{detail}}',
  shellSyntax: "{{text}} uses shell syntax that extra arguments don't allow.",
  terminator: '"--" isn\'t allowed in extra arguments.',
  notAnOption:
    '"{{token}}" isn\'t an option. Extra arguments for {{agent}} accept only: {{allowed}}.',
  optionNotAllowed:
    '"{{option}}" isn\'t allowed in extra arguments for {{agent}}. Allowed: {{allowed}}.',
  missingValue: '"{{option}}" needs a value.',
  valueNotAllowed:
    '"{{option}} {{value}}" isn\'t allowed. {{agent}} extra arguments accept only "{{option}} {{prefix}}<level>".',
  modelRepeated: 'Extra arguments set the model more than once.',
  effortRepeated: 'Extra arguments set the effort more than once.'
} as const

export type ExtraAgentArgsFailureCode = keyof typeof EXTRA_AGENT_ARGS_FAILURE_COPY

export type ExtraAgentArgsFailure = {
  ok: false
  error: string
  errorCode: ExtraAgentArgsFailureCode
  errorParams?: Record<string, string>
}
