/**
 * Claude's command-line grammar, as tables, for one question: does this argv positively start an
 * interactive session that owns the foreground terminal and draws Claude's composer (STA-14925)?
 *
 * Source: `claude --help` and `claude agents|attach|import --help` of Claude Code 2.1.322, with
 * token consumption checked against that CLI through `--help` probes (which usage a given argv
 * prints). The CLI parses like commander.js: a required value takes the next token whatever it is,
 * an optional value takes the next token unless it looks like an option, a variadic value takes
 * every following token up to the next option, `--opt=value` binds inline, short flags combine
 * (`-cd`), `--` ends option parsing only, and the first operand names the subcommand wherever it
 * stands (`claude --model opus mcp serve`, `claude -- mcp list`).
 *
 * Why fail safe: a wrong "interactive" holds a pane for a composer that never comes, so anything
 * this table does not positively recognize (an option of a newer or older CLI, an unexpected token
 * shape) is `unclassified` and the caller keeps its earlier any-visible-byte rule.
 */

export type ClaudeArgvKind =
  /** A foreground session: bare, with a prompt, resumed, or a subcommand that opens one. */
  | 'interactive-session'
  /** `--help` / `--version`: prints and exits. */
  | 'informational'
  /** `--print` and the options that only work with it: a one-shot with no composer. */
  | 'headless'
  /** `--bg` and the other launches that hand the session to somewhere other than this terminal. */
  | 'non-foreground'
  /** A subcommand that runs a server, an installer, an auth flow or a report. */
  | 'non-session-subcommand'
  /** Not recognized with confidence; never treated as interactive. */
  | 'unclassified'

type OptionArity = 'flag' | 'required' | 'optional' | 'variadic'
export type OptionEffect = Exclude<
  ClaudeArgvKind,
  'interactive-session' | 'non-session-subcommand' | 'unclassified'
>
export type OptionSpec = {
  arity: OptionArity
  effect?: OptionEffect
  /** Values the CLI accepts; anything else is a usage error. */
  choices?: readonly string[]
}
export type OptionTable = ReadonlyMap<string, OptionSpec>

function optionTable(
  groups: readonly OptionGroup[],
  choices: Readonly<Record<string, readonly string[]>> = {}
): OptionTable {
  const table = new Map<string, OptionSpec>()
  for (const { names, spec } of groups) {
    for (const name of names) {
      table.set(name, choices[name] ? { ...spec, choices: choices[name] } : spec)
    }
  }
  return table
}

type OptionGroup = { names: readonly string[]; spec: OptionSpec }

const HELP_OPTION: OptionGroup = {
  names: ['-h', '--help'],
  spec: { arity: 'flag', effect: 'informational' }
}

export const ROOT_OPTIONS = optionTable(
  [
    HELP_OPTION,
    { names: ['-v', '--version'], spec: { arity: 'flag', effect: 'informational' } },
    { names: ['-p', '--print'], spec: { arity: 'flag', effect: 'headless' } },
    // Documented as "only works with --print": with it a one-shot, without it not a launch whose
    // composer can be counted on.
    {
      names: [
        '--forward-subagent-text',
        '--include-hook-events',
        '--include-partial-messages',
        '--no-session-persistence',
        '--replay-user-messages'
      ],
      spec: { arity: 'flag', effect: 'headless' }
    },
    {
      names: [
        '--input-format',
        '--json-schema',
        '--max-budget-usd',
        '--output-format',
        '--permission-prompts'
      ],
      spec: { arity: 'required', effect: 'headless' }
    },
    // The session runs in the background, the desktop app, the cloud or another tmux pane.
    {
      names: ['--bg', '--background', '--desktop', '--tmux'],
      spec: { arity: 'flag', effect: 'non-foreground' }
    },
    { names: ['--environment'], spec: { arity: 'required', effect: 'non-foreground' } },
    { names: ['--cloud'], spec: { arity: 'optional', effect: 'non-foreground' } },
    {
      names: [
        '--allow-dangerously-skip-permissions',
        '--ax-screen-reader',
        '--bare',
        '--brief',
        '--chrome',
        '-c',
        '--continue',
        '--dangerously-skip-permissions',
        '--disable-slash-commands',
        '--exclude-dynamic-system-prompt-sections',
        '--fork-session',
        '--ide',
        '--no-chrome',
        '--restricted',
        '--safe-mode',
        '--strict-mcp-config',
        '--verbose'
      ],
      spec: { arity: 'flag' }
    },
    {
      names: [
        '--agent',
        '--agents',
        '--append-system-prompt',
        '--autocompact',
        '--debug-file',
        '--effort',
        '--fallback-model',
        '--model',
        '-n',
        '--name',
        '--permission-mode',
        '--plugin-dir',
        '--plugin-url',
        '--remote-control-session-name-prefix',
        '--session-id',
        '--setting-sources',
        '--settings',
        '--system-prompt',
        '--system-prompt-snapshot'
      ],
      spec: { arity: 'required' }
    },
    {
      names: [
        '-d',
        '--debug',
        '--from-pr',
        '--prompt-suggestions',
        '--remote-control',
        '-r',
        '--resume',
        '--teleport',
        '-w',
        '--worktree'
      ],
      spec: { arity: 'optional' }
    },
    {
      names: [
        '--add-dir',
        '--allowedTools',
        '--allowed-tools',
        '--betas',
        '--disallowedTools',
        '--disallowed-tools',
        '--file',
        '--mcp-config',
        '--tools'
      ],
      spec: { arity: 'variadic' }
    }
  ],
  {
    '--input-format': ['text', 'stream-json'],
    '--output-format': ['text', 'json', 'stream-json'],
    '--permission-mode': ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
    '--permission-prompts': ['host', 'none'],
    '--prompt-suggestions': ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'],
    '--system-prompt-snapshot': ['on', 'off']
  }
)

export type SessionSubcommand = {
  options: OptionTable
  /** How many operands the subcommand takes; any other count is not a launch this table knows. */
  operands: { min: number; max: number }
}

// The subcommands that open a view or session in this terminal, with their own options.
export const SESSION_SUBCOMMANDS: ReadonlyMap<string, SessionSubcommand> = new Map([
  [
    'agents',
    {
      options: optionTable([
        HELP_OPTION,
        // `--json` prints the session list and exits.
        { names: ['--json'], spec: { arity: 'flag', effect: 'headless' } },
        {
          names: [
            '--all',
            '--allow-dangerously-skip-permissions',
            '--dangerously-skip-permissions',
            '--restricted',
            '--strict-mcp-config'
          ],
          spec: { arity: 'flag' }
        },
        {
          names: [
            '--add-dir',
            '--agent',
            '--cwd',
            '--effort',
            '--mcp-config',
            '--model',
            '--permission-mode',
            '--plugin-dir',
            '--setting-sources',
            '--settings'
          ],
          spec: { arity: 'required' }
        }
      ]),
      operands: { min: 0, max: 0 }
    }
  ],
  ['attach', { options: optionTable([HELP_OPTION]), operands: { min: 1, max: 1 } }],
  // `--dry-run` and `--yes` skip or replace the interactive picker, so they stay unrecognized.
  ['import', { options: optionTable([HELP_OPTION]), operands: { min: 0, max: 1 } }]
])

export const NON_SESSION_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade'
])
