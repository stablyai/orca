import type { TuiAgent } from './tui-agent'
import { getOrcaCliCommandNameForPlatform } from './orca-cli-command-name'
import type { TuiAgentConfig, TuiAgentConfigSource } from './tui-agent-config-types'

export type {
  AgentPromptInjectionMode,
  DraftPasteMarkerSignal,
  DraftPasteReadySignal,
  TuiAgentConfig,
  TuiAgentDetectionRuntime
} from './tui-agent-config-types'

function resolveTuiAgentConfig(source: TuiAgentConfigSource): TuiAgentConfig {
  return {
    ...source,
    launchCmd: source.launchCmd ?? source.detectCmd,
    expectedProcess: source.expectedProcess ?? source.detectCmd
  }
}

const TUI_AGENT_CONFIG_SOURCE: Record<TuiAgent, TuiAgentConfigSource> = {
  claude: {
    detectCmd: 'claude',
    promptInjectionMode: 'argv',
    pasteNeedsTypedRequest: true,
    // Native --prefill avoids paste-after-ready races (https://github.com/stablyai/orca/pull/926).
    draftPromptFlag: '--prefill',
    preflightTrust: 'claude',
    // Why: CLAUDE_CODE_DISABLE_TERMINAL_TITLE drops the `✳` title tui-idle waits on (#22655).
    draftPasteReadySignal: 'claude-composer-prompt',
    workerStartReadsComposerMarker: true,
    // Why: Claude decodes CSI-u Ctrl+Enter on local ConPTY; CR made a remapped ctrl+enter act as Enter (#29711).
    ctrlEnterEncoding: 'csi-u'
  },
  'claude-agent-teams': {
    // This launch mode uses Orca’s CLI wrapper rather than a separate agent binary.
    detectCmd: 'orca',
    detectCmdAliases: ['orca-dev', 'orca-ide'],
    // Orca’s always-present shim alone must not report installed Agent Teams without Claude.
    detectRequiredCommands: ['claude'],
    // Windows/WSL use Claude’s in-process fallback, not this native-pane/tmux wrapper.
    detectUnsupportedRuntimes: ['win32', 'wsl'],
    launchCmd: 'orca claude-teams',
    launchCmdByPlatform: {
      linux: `${getOrcaCliCommandNameForPlatform('linux')} claude-teams`,
      win32: `${getOrcaCliCommandNameForPlatform('win32')} claude-teams`
    },
    expectedProcess: 'claude',
    promptInjectionMode: 'stdin-after-start',
    pasteNeedsTypedRequest: true,
    preflightTrust: 'claude',
    draftPasteReadySignal: 'claude-composer-prompt',
    workerStartReadsComposerMarker: true,
    // Why: runs the same Claude binary, so Ctrl+Enter must match `claude`.
    ctrlEnterEncoding: 'csi-u'
  },
  codebuddy: {
    detectCmd: 'codebuddy',
    detectCmdAliases: ['cbc'],
    promptInjectionMode: 'argv'
  },
  openclaude: {
    detectCmd: 'openclaude',
    promptInjectionMode: 'argv',
    draftPromptFlag: '--prefill'
  },
  codex: {
    detectCmd: 'codex',
    promptInjectionMode: 'argv',
    windowsInputRecordPasteNewline: 'alt-enter',
    preflightTrust: 'codex',
    draftPasteReadySignal: 'codex-composer-prompt',
    draftPasteReadyTimeoutMs: 20_000,
    submitRetryDelayMs: 1200
  },
  autohand: { detectCmd: 'autohand', promptInjectionMode: 'stdin-after-start' },
  ante: {
    detectCmd: 'ante',
    // Why: `ante --prompt` is headless (runs once and exits), so launch the bare TUI and inject after startup.
    promptInjectionMode: 'stdin-after-start'
  },
  trae: {
    // Use TRAE CN’s unique traecli alias; unrelated bytedance/trae-agent also installs trae-cli.
    detectCmd: 'traecli',
    promptInjectionMode: 'argv',
    // Cobra’s -- stops subcommands and flags from consuming prompt text such as help/config/-….
    argvPromptSeparator: '--'
  },
  opencode: {
    detectCmd: 'opencode',
    promptInjectionMode: 'flag-prompt',
    // Why: opencode enables bracketed paste before its composer mounts; wait for the post-\x1b[?2004h show-cursor so paste lands.
    draftPasteReadySignal: 'render-cursor-after-bracketed-paste',
    // OpenCode 2 renders input before loading its agent list; only the later agent/model row proves submit readiness.
    submitPasteReadySignal: 'opencode-agent-row',
    // Two Windows ConPTY hosts enabled paste at ~4.8s and composer readiness at ~10s; the 8s default pasted blind. Signals arrived reliably (#22479).
    draftPasteReadyTimeoutMs: 20_000,
    // Why: OpenCode decodes CSI-u Ctrl+Enter without local ConPTY kitty negotiation (#25372).
    ctrlEnterEncoding: 'csi-u',
    composerReadyCaptures: [
      'opencode-1-18-32-timed-boot-slow',
      'opencode-1-18-32-timed-boot-hidden-pane',
      'opencode-1-18-32-timed-first-launch',
      'opencode-cmd-2-0-21-timed-warm-server'
    ]
  },
  opencode2: {
    detectCmd: 'opencode2',
    // The private server inherits this pane's hook endpoint and identity.
    launchCmd: 'opencode2 --standalone',
    promptInjectionMode: 'flag-prompt',
    draftPasteReadySignal: 'render-cursor-after-bracketed-paste',
    submitPasteReadySignal: 'opencode-agent-row',
    draftPasteReadyTimeoutMs: 20_000,
    composerReadyCaptures: [
      'opencode-2-0-18-timed-boot-hidden-pane',
      'opencode-2-0-21-timed-cold-standalone',
      'opencode-2-0-21-timed-cold-standalone-hidden-pane',
      'opencode-2-0-21-timed-natural-load-enter-dropped',
      'opencode-2-0-14-timed-cold-standalone'
    ]
  },
  'mimo-code': {
    detectCmd: 'mimo',
    promptInjectionMode: 'flag-prompt',
    // Mirror OpenCode’s cursor gate by parity; MiMo startup has not been separately validated.
    draftPasteReadySignal: 'render-cursor-after-bracketed-paste'
  },
  pi: {
    detectCmd: 'pi',
    promptInjectionMode: 'argv',
    // Pi has no prefill flag; the managed extension seeds env to avoid its long startup paste race.
    draftPromptEnvVar: 'ORCA_PI_PREFILL',
    // Why: Pi decodes CSI-u; Esc+CR submits after tool subprocesses reset live KKP state (#9703).
    windowsShiftEnterEncoding: 'csi-u'
  },
  omp: {
    detectCmd: 'omp',
    promptInjectionMode: 'argv',
    draftPromptEnvVar: 'ORCA_OMP_PREFILL',
    // OMP embeds Pi’s CSI-u reader; preserve newline encoding after live Kitty state resets.
    windowsShiftEnterEncoding: 'csi-u'
  },
  'prime-agent': {
    detectCmd: 'prime-agent',
    promptInjectionMode: 'argv',
    // -- forces all later arguments to be messages instead of Prime Agent subcommands/flags.
    argvPromptSeparator: '--',
    // Prime Agent embeds Pi’s CSI-u reader.
    windowsShiftEnterEncoding: 'csi-u'
  },
  qoder: {
    detectCmd: 'qodercli',
    // The documented `qoder` dispatcher still launches the legacy CLI binary.
    detectCmdAliases: ['qoder'],
    promptInjectionMode: 'flag-prompt-interactive',
    preflightTrust: 'qoder'
  },
  'qoder-cn': {
    detectCmd: 'qoderclicn',
    detectCmdAliases: ['qodercn'],
    promptInjectionMode: 'flag-prompt-interactive',
    preflightTrust: 'qoder-cn'
  },
  gemini: {
    detectCmd: 'gemini',
    promptInjectionMode: 'flag-prompt-interactive'
  },
  antigravity: {
    detectCmd: 'agy',
    promptInjectionMode: 'flag-prompt-interactive',
    // Antigravity trust is exact-path, so every child workspace can show a menu that consumes paste; pre-write trust (agent-trust-presets.ts).
    preflightTrust: 'antigravity',
    // agy 1.2.x expands collapsed multiline pastes over seconds; byte ingest finishing does not prove submit readiness.
    submitLineSettleMsPerLine: 45
  },
  aider: {
    detectCmd: 'aider',
    promptInjectionMode: 'stdin-after-start'
  },
  goose: {
    detectCmd: 'goose',
    promptInjectionMode: 'stdin-after-start'
  },
  amp: {
    detectCmd: 'amp',
    promptInjectionMode: 'stdin-after-start'
  },
  kilo: {
    detectCmd: 'kilo',
    promptInjectionMode: 'stdin-after-start'
  },
  kiro: {
    // The installer ships kiro-cli; preserve kiro as the stored preference ID.
    detectCmd: 'kiro-cli',
    // Kiro trust flags belong to chat, not the top-level command.
    launchCmd: 'kiro-cli chat --tui',
    promptInjectionMode: 'stdin-after-start'
  },
  crush: {
    detectCmd: 'crush',
    promptInjectionMode: 'stdin-after-start'
  },
  aug: {
    // The package installs auggie; preserve aug as the stored preference ID.
    detectCmd: 'auggie',
    promptInjectionMode: 'stdin-after-start'
  },
  cline: {
    detectCmd: 'cline',
    promptInjectionMode: 'stdin-after-start'
  },
  freebuff: {
    detectCmd: 'freebuff',
    promptInjectionMode: 'stdin-after-start'
  },
  codebuff: {
    detectCmd: 'codebuff',
    promptInjectionMode: 'stdin-after-start'
  },
  'command-code': {
    // Avoid cmd alias detection colliding with Windows cmd.exe.
    detectCmd: 'command-code',
    // Why: `--trust` skips the first-run trust prompt so it doesn't consume the task text.
    launchCmd: 'command-code --trust',
    promptInjectionMode: 'argv'
  },
  continue: {
    // Use the actual cn binary; continue resolves to a shell keyword.
    detectCmd: 'cn',
    promptInjectionMode: 'stdin-after-start'
  },
  cursor: {
    detectCmd: 'cursor-agent',
    promptInjectionMode: 'argv',
    // Why: first-launch trust menu swallows the bracketed paste; pre-write the .workspace-trusted marker so it skips (agent-trust-presets.ts).
    preflightTrust: 'cursor'
  },
  droid: {
    detectCmd: 'droid',
    promptInjectionMode: 'argv',
    // Why: Droid decodes CSI-u on Windows; the legacy Esc+CR fallback reads as Enter and submits instead of newline.
    windowsShiftEnterEncoding: 'csi-u',
    ctrlEnterEncoding: 'csi-u'
  },
  kimi: {
    preflightTrust: 'kimi',
    // The kimi launcher runs as kimi-code; recognize the alias for reuse and dispatch --inject.
    detectCmd: 'kimi',
    detectCmdAliases: ['kimi-code'],
    promptInjectionMode: 'stdin-after-start'
  },
  'mistral-vibe': {
    // Installers expose vibe; keep mistral-vibe for wrapped installs.
    detectCmd: 'vibe',
    detectCmdAliases: ['mistral-vibe'],
    promptInjectionMode: 'stdin-after-start'
  },
  'qwen-code': {
    detectCmd: 'qwen',
    promptInjectionMode: 'stdin-after-start',
    // Qwen 0.24.7 drops Enter for 500ms after paste on Windows/Node <20; delayed retry is harmless if the first submit landed.
    submitRetryDelayMs: 1200
  },
  rovo: {
    // Rovo is an acli subcommand; passing an instruction there would run one-shot.
    detectCmd: 'acli',
    launchCmd: 'acli rovodev run',
    promptInjectionMode: 'stdin-after-start'
  },
  hermes: {
    detectCmd: 'hermes',
    // Bare hermes opens the classic REPL; --tui selects the hosted full-screen interface.
    launchCmd: 'hermes --tui',
    // Why: Hermes delivers the prompt via its startup-query contract, submitting only after the composer is ready.
    promptInjectionMode: 'hermes-query'
  },
  openclaw: {
    detectCmd: 'openclaw',
    promptInjectionMode: 'stdin-after-start'
  },
  copilot: {
    detectCmd: 'copilot',
    // Why: `--prompt` exits on completion (kills the hosted session); `-i/--interactive` keeps it interactive.
    promptInjectionMode: 'flag-interactive',
    // Why: first-launch trust menu swallows the bracketed paste; pre-write trust so it skips (see agent-trust-presets.ts).
    preflightTrust: 'copilot'
  },
  grok: {
    detectCmd: 'grok',
    // Why: argv (grok takes a positional prompt) so multi-line/special-char text isn't mangled as raw PTY keystrokes.
    promptInjectionMode: 'argv',
    // Why: separator so prompts like `help`/`--version` aren't parsed as Grok CLI syntax.
    argvPromptSeparator: '--',
    // Grok’s shimmering logo never satisfies render quiet; its composer glyph arrives around 0.6s instead of the 8s timeout.
    draftPasteReadySignal: 'grok-composer-prompt',
    ctrlEnterEncoding: 'csi-u'
  },
  muse: {
    detectCmd: 'muse',
    launchCmd: 'muse --trust-workspace',
    // Muse 1.3 treats subcommand-shaped prompts as commands even after `--`.
    promptInjectionMode: 'stdin-after-start'
  },
  dsh: {
    detectCmd: 'dsh-tui',
    detectCmdAliases: ['dst'],
    detectRequiredCommands: ['dsh'],
    // A first bare launch opens the session browser instead of the composer.
    launchCmd: 'dsh-tui .',
    expectedProcess: 'dsh',
    promptInjectionMode: 'stdin-after-start',
    // The whale intro keeps repainting behind the ready composer.
    draftPasteReadySignal: 'dsh-composer-prompt',
    // Why: dsh-tui 0.17's launchpad refuses Enter, keeping the draft, until its session opens (1-24 s).
    submitRetryDelayMs: 1000,
    submitRetryBudgetMs: 30_000
  },
  zcode: {
    detectCmd: 'zcode',
    // ZCode sets process.title to zcode-cli; matching only its zcode launch name would reject dispatch as no_agent_detected.
    expectedProcess: 'zcode-cli',
    // ZCode treats positional text as subcommands and -p is headless; inject into the running TUI.
    promptInjectionMode: 'stdin-after-start',
    // Its banner animates indefinitely; wait for the input box corner instead of render quiet.
    draftPasteReadySignal: 'zcode-composer-prompt',
    composerReadyCaptures: ['zcode-composer-ready']
  },
  // Why: stdin-after-start's follow-up wrote before Devin's input loop existed (#26302); `devin -- <prompt>` submits reliably.
  // prettier-ignore
  devin: { detectCmd: 'devin', promptInjectionMode: 'argv', argvPromptSeparator: '--' },
  // prettier-ignore
  jcode: { detectCmd: 'jcode', launchCmd: 'jcode', expectedProcess: 'jcode', promptInjectionMode: 'stdin-after-start' }
}

export const TUI_AGENT_CONFIG: Record<TuiAgent, TuiAgentConfig> = Object.fromEntries(
  Object.entries(TUI_AGENT_CONFIG_SOURCE).map(([agent, source]) => [
    agent,
    resolveTuiAgentConfig(source)
  ])
) as Record<TuiAgent, TuiAgentConfig>

export function isTuiAgent(value: unknown): value is TuiAgent {
  return typeof value === 'string' && Object.hasOwn(TUI_AGENT_CONFIG, value)
}

export function getTuiAgentDetectCommands(config: TuiAgentConfig): string[] {
  return [config.detectCmd, ...(config.detectCmdAliases ?? [])]
}

export function getTuiAgentLaunchCommand(
  config: TuiAgentConfig,
  platform: NodeJS.Platform,
  opts?: { isRemote?: boolean }
): string {
  // The GNOME-conflict orca-ide rename is local-only; Linux remote shims are always orca.
  if (opts?.isRemote && platform === 'linux') {
    return config.launchCmd
  }
  return config.launchCmdByPlatform?.[platform] ?? config.launchCmd
}
