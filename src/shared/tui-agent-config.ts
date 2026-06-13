import type { TuiAgent } from './types'

export type AgentPromptInjectionMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-prompt-interactive'
  | 'flag-interactive'
  | 'stdin-after-start'

export type DraftPasteReadySignal = 'render-quiet-after-bracketed-paste' | 'codex-composer-prompt'

export type TuiAgentConfig = {
  detectCmd: string
  /** Additional executable names that identify the same agent on PATH. */
  detectCmdAliases?: readonly string[]
  launchCmd: string
  expectedProcess: string
  promptInjectionMode: AgentPromptInjectionMode
  /** Why: flag that launches the TUI with the given text already in the
   * input box but NOT submitted, so the user still gets a reviewable draft.
   * Only set when the CLI documents native support — e.g. Claude's
   * `--prefill <text>`. The draft-launch flow prefers this over the
   * post-launch bracketed-paste path because it eliminates the empirical
   * agent-readiness wait entirely: the TUI mounts with the input pre-filled.
   * Agents without native support fall through to the paste-after-ready
   * code path in agent-paste-draft.ts. */
  draftPromptFlag?: string
  /** Why: agents that don't expose a `--prefill <text>`-style CLI flag but
   * CAN read an env var on startup to seed their input box without
   * submitting. Today only pi uses this (via Orca's overlay-installed
   * `orca-prefill` extension reading `ORCA_PI_PREFILL`). Equivalent in
   * effect to `draftPromptFlag`: avoids the bracketed-paste-after-ready
   * race when the agent's startup output is long (pi prints banner,
   * skills, and extensions for several seconds, which keeps the
   * readiness quiet-timer resetting). When set, the draft-launch plan
   * passes the text via this env var instead of pasting after ready. */
  draftPromptEnvVar?: string
  /** Why: agents that gate first-launch behind a "Do you trust this
   * folder?" menu (Cursor-Agent, GitHub Copilot CLI, Codex) consume the
   * bracketed paste as menu input. Pre-write the same trust artifact the
   * agent writes after the user accepts so the menu never fires. The actual
   * file/path written lives in src/main/agent-trust-presets.ts; this flag
   * just routes the workspace path through the matching preset before the
   * agent spawns. */
  preflightTrust?: 'cursor' | 'copilot' | 'codex'
  /** Why: most TUIs need both bracketed-paste enablement and a quiet render
   * window before pasted bytes reliably land in the composer. Codex can use
   * a stronger signal from its own renderer: chat_composer.rs writes the
   * `›` prompt only when the composer row exists, so Orca can paste as soon
   * as that prompt appears after bracketed paste is enabled. */
  draftPasteReadySignal?: DraftPasteReadySignal
}

export const TUI_AGENT_CONFIG: Record<TuiAgent, TuiAgentConfig> = {
  claude: {
    detectCmd: 'claude',
    launchCmd: 'claude',
    expectedProcess: 'claude',
    promptInjectionMode: 'argv',
    // Why: `claude --prefill <text>` lands the TUI with `<text>` in the
    // input box, nothing submitted. Strictly better than the paste-after-
    // ready fallback because it eliminates the readiness race entirely.
    // See PR https://github.com/stablyai/orca/pull/926 for context.
    draftPromptFlag: '--prefill'
  },
  'claude-agent-teams': {
    // Why: this is an Orca-provided launch mode, not a separate upstream
    // binary. Detection follows the Orca CLI, while the wrapper validates the
    // real Claude binary when it starts.
    detectCmd: 'orca',
    detectCmdAliases: ['orca-dev', 'orca-ide'],
    launchCmd: 'orca claude-teams',
    expectedProcess: 'claude',
    promptInjectionMode: 'stdin-after-start'
  },
  openclaude: {
    detectCmd: 'openclaude',
    launchCmd: 'openclaude',
    expectedProcess: 'openclaude',
    promptInjectionMode: 'argv',
    draftPromptFlag: '--prefill'
  },
  codex: {
    detectCmd: 'codex',
    launchCmd: 'codex',
    expectedProcess: 'codex',
    promptInjectionMode: 'argv',
    preflightTrust: 'codex',
    draftPasteReadySignal: 'codex-composer-prompt'
  },
  autohand: {
    detectCmd: 'autohand',
    launchCmd: 'autohand',
    expectedProcess: 'autohand',
    promptInjectionMode: 'stdin-after-start'
  },
  opencode: {
    detectCmd: 'opencode',
    launchCmd: 'opencode',
    expectedProcess: 'opencode',
    promptInjectionMode: 'flag-prompt'
  },
  pi: {
    detectCmd: 'pi',
    launchCmd: 'pi',
    expectedProcess: 'pi',
    promptInjectionMode: 'argv',
    // Why: pi has no `--prefill` flag, and bracketed-paste-after-ready
    // races against its multi-second startup output (banner + skills +
    // extensions list) so the paste frequently never lands. Orca's
    // overlay installs an `orca-prefill` pi extension (see
    // src/main/pi/titlebar-extension-service.ts) that reads this env var
    // on session_start and calls `pi.ui.setEditorText(text)`. Same
    // user-visible behavior as `claude --prefill <text>`.
    draftPromptEnvVar: 'ORCA_PI_PREFILL'
  },
  omp: {
    detectCmd: 'omp',
    launchCmd: 'omp',
    expectedProcess: 'omp',
    promptInjectionMode: 'argv',
    draftPromptEnvVar: 'ORCA_OMP_PREFILL'
  },
  gemini: {
    detectCmd: 'gemini',
    launchCmd: 'gemini',
    expectedProcess: 'gemini',
    promptInjectionMode: 'flag-prompt-interactive'
  },
  antigravity: {
    detectCmd: 'agy',
    launchCmd: 'agy',
    expectedProcess: 'agy',
    promptInjectionMode: 'flag-prompt-interactive'
  },
  aider: {
    detectCmd: 'aider',
    launchCmd: 'aider',
    expectedProcess: 'aider',
    promptInjectionMode: 'stdin-after-start'
  },
  goose: {
    detectCmd: 'goose',
    launchCmd: 'goose',
    expectedProcess: 'goose',
    promptInjectionMode: 'stdin-after-start'
  },
  amp: {
    detectCmd: 'amp',
    launchCmd: 'amp',
    expectedProcess: 'amp',
    promptInjectionMode: 'stdin-after-start'
  },
  kilo: {
    detectCmd: 'kilo',
    launchCmd: 'kilo',
    expectedProcess: 'kilo',
    promptInjectionMode: 'stdin-after-start'
  },
  kiro: {
    // Why: the official Kiro installer (https://cli.kiro.dev/install) places a
    // binary named `kiro-cli` on PATH — there is no `kiro` binary. Keep the
    // TuiAgent id as 'kiro' for stored preferences, but detect/launch/identify
    // the real binary name so the agent is recognized as active.
    detectCmd: 'kiro-cli',
    // Why: trust flags are accepted by Kiro's chat subcommand, not the
    // top-level kiro-cli command. Keep TUI startup explicit so default args
    // like --trust-all-tools are appended where the installed CLI accepts them.
    launchCmd: 'kiro-cli chat --tui',
    expectedProcess: 'kiro-cli',
    promptInjectionMode: 'stdin-after-start'
  },
  crush: {
    detectCmd: 'crush',
    launchCmd: 'crush',
    expectedProcess: 'crush',
    promptInjectionMode: 'stdin-after-start'
  },
  aug: {
    // Why: the published @augmentcode/auggie npm package installs a binary
    // named `auggie` (not `aug`). Keep the TuiAgent id as 'aug' for stored
    // preferences, but detect/launch/identify the real binary name.
    detectCmd: 'auggie',
    launchCmd: 'auggie',
    expectedProcess: 'auggie',
    promptInjectionMode: 'stdin-after-start'
  },
  cline: {
    detectCmd: 'cline',
    launchCmd: 'cline',
    expectedProcess: 'cline',
    promptInjectionMode: 'stdin-after-start'
  },
  codebuff: {
    detectCmd: 'codebuff',
    launchCmd: 'codebuff',
    expectedProcess: 'codebuff',
    promptInjectionMode: 'stdin-after-start'
  },
  'command-code': {
    // Why: `npm i -g command-code` installs two binaries — `command-code` and
    // the shorter alias `cmd`. Use the full `command-code` name so detection
    // does not collide with Windows' built-in `cmd.exe` shell, which
    // agent-process-recognition normalizes to `cmd` after stripping the .exe.
    detectCmd: 'command-code',
    // Why: Command Code's documented positional prompt starts the turn, while
    // paste-after-start can leave the prompt sitting in the composer. `--trust`
    // mirrors the preflight trust behavior Orca applies to other first-run
    // TUIs so launch prompts do not consume the task text.
    launchCmd: 'command-code --trust',
    expectedProcess: 'command-code',
    promptInjectionMode: 'argv'
  },
  continue: {
    // Why: Continue's CLI binary is `cn`; `continue` is a shell builtin in
    // bash/zsh, so using it here can resolve to the shell keyword instead of
    // the coding agent.
    detectCmd: 'cn',
    launchCmd: 'cn',
    expectedProcess: 'cn',
    promptInjectionMode: 'stdin-after-start'
  },
  cursor: {
    detectCmd: 'cursor-agent',
    launchCmd: 'cursor-agent',
    expectedProcess: 'cursor-agent',
    promptInjectionMode: 'argv',
    // Why: cursor-agent's first-launch trust menu ([a]/[w]/[q]) used to
    // swallow our bracketed paste. Pre-writing the same `.workspace-trusted`
    // marker the CLI itself writes after the user accepts (see
    // agent-trust-presets.ts) makes the menu skip entirely, so the draft
    // URL paste lands in the input as intended.
    preflightTrust: 'cursor'
  },
  droid: {
    detectCmd: 'droid',
    launchCmd: 'droid',
    expectedProcess: 'droid',
    promptInjectionMode: 'argv'
  },
  kimi: {
    detectCmd: 'kimi',
    launchCmd: 'kimi',
    expectedProcess: 'kimi',
    promptInjectionMode: 'stdin-after-start'
  },
  'mistral-vibe': {
    // Why: Mistral's installer and PyPI package expose `vibe` even though the
    // package/project name is mistral-vibe. Keep the old name as an alias for
    // manually wrapped installs.
    detectCmd: 'vibe',
    detectCmdAliases: ['mistral-vibe'],
    launchCmd: 'vibe',
    expectedProcess: 'vibe',
    promptInjectionMode: 'stdin-after-start'
  },
  'qwen-code': {
    detectCmd: 'qwen-code',
    launchCmd: 'qwen-code',
    expectedProcess: 'qwen-code',
    promptInjectionMode: 'stdin-after-start'
  },
  rovo: {
    detectCmd: 'rovo',
    launchCmd: 'rovo',
    expectedProcess: 'rovo',
    promptInjectionMode: 'stdin-after-start'
  },
  hermes: {
    detectCmd: 'hermes',
    // Why: bare `hermes` opens the classic REPL in recent Hermes releases;
    // `--tui` starts the full-screen agent UI Orca is designed to host.
    launchCmd: 'hermes --tui',
    expectedProcess: 'hermes',
    promptInjectionMode: 'stdin-after-start'
  },
  openclaw: {
    detectCmd: 'openclaw',
    launchCmd: 'openclaw',
    expectedProcess: 'openclaw',
    promptInjectionMode: 'stdin-after-start'
  },
  copilot: {
    detectCmd: 'copilot',
    launchCmd: 'copilot',
    expectedProcess: 'copilot',
    // Why: `copilot --prompt <text>` runs non-interactively and exits on
    // completion, which would kill the TUI session Orca is hosting.
    // `-i/--interactive <prompt>` starts an interactive session with the
    // initial prompt pre-executed — the behavior Orca needs.
    promptInjectionMode: 'flag-interactive',
    // Why: Copilot's first-launch trust menu used to swallow our bracketed
    // paste. Pre-appending the workspace path to `trustedFolders` in
    // ~/.copilot/config.json (the same array Copilot's own
    // `addTrustedFolder` writes after the user accepts) makes the menu skip
    // entirely. See agent-trust-presets.ts for the file layout.
    preflightTrust: 'copilot'
  },
  grok: {
    detectCmd: 'grok',
    launchCmd: 'grok',
    expectedProcess: 'grok',
    promptInjectionMode: 'stdin-after-start'
  },
  devin: {
    detectCmd: 'devin',
    launchCmd: 'devin',
    expectedProcess: 'devin',
    // Why: `devin -- <prompt>` auto-submits the prompt (the issue's claim
    // that it pre-fills without submitting is incorrect per the official
    // docs at docs.devin.ai/cli/reference/commands). `stdin-after-start`
    // launches the REPL first, then pastes via bracketed paste so the
    // user can review before submitting — same as aider, goose, amp, etc.
    promptInjectionMode: 'stdin-after-start'
  }
}

export function isTuiAgent(value: unknown): value is TuiAgent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TUI_AGENT_CONFIG, value)
}

export function getTuiAgentDetectCommands(config: TuiAgentConfig): string[] {
  return [config.detectCmd, ...(config.detectCmdAliases ?? [])]
}
