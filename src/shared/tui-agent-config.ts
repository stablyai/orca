import type { TuiAgent } from './types'

export type AgentPromptInjectionMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-prompt-interactive'
  | 'flag-interactive'
  | 'stdin-after-start'

export type TuiAgentConfig = {
  detectCmd: string
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
   * folder?" menu (Cursor-Agent, GitHub Copilot CLI) consume the bracketed
   * paste as menu input. Pre-write the same trust artifact the agent writes
   * after the user accepts so the menu never fires. The actual file/path
   * written lives in src/main/agent-trust-presets.ts; this flag just routes
   * the workspace path through the matching preset before the agent spawns. */
  preflightTrust?: 'cursor' | 'copilot'
}

// Why: the new-workspace handoff depends on three pieces of per-agent
// knowledge staying in sync: how Orca detects the agent on PATH, which binary
// it actually launches, and whether the initial prompt should be passed as an
// argv flag/argument or typed into the interactive session after startup.
// Centralizing that metadata prevents the picker, launcher, and preflight
// checks from quietly drifting apart as new agents are added.
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
  codex: {
    detectCmd: 'codex',
    launchCmd: 'codex',
    expectedProcess: 'codex',
    promptInjectionMode: 'argv'
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
  gemini: {
    detectCmd: 'gemini',
    launchCmd: 'gemini',
    expectedProcess: 'gemini',
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
    launchCmd: 'kiro-cli',
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
  continue: {
    detectCmd: 'continue',
    launchCmd: 'continue',
    expectedProcess: 'continue',
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
    detectCmd: 'mistral-vibe',
    launchCmd: 'mistral-vibe',
    expectedProcess: 'mistral-vibe',
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
    launchCmd: 'hermes',
    expectedProcess: 'hermes',
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
  }
}

export function isTuiAgent(value: unknown): value is TuiAgent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TUI_AGENT_CONFIG, value)
}
