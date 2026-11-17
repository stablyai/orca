import type { TuiAgent } from './tui-agent'
import type { TuiAgentConfigSource } from './tui-agent-config-types'

// The newest agents, split out to keep tui-agent-config.ts within its line budget; spread back in order.
export const TAIL_TUI_AGENT_CONFIG_SOURCE = {
  muse: {
    detectCmd: 'muse',
    launchCmd: 'muse --trust-workspace',
    // Muse 1.3 treats subcommand-shaped prompts as commands even after `--`.
    promptInjectionMode: 'stdin-after-start',
    // Why: Windows Muse reads console input records (crossterm), so an Enter landing mid-paste stays in its draft (#43126).
    windowsInputRecordPasteNewline: 'alt-enter'
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
  jcode: { detectCmd: 'jcode', launchCmd: 'jcode', expectedProcess: 'jcode', promptInjectionMode: 'stdin-after-start' },
  // glab execs its off-PATH `duo` binary; `--goal` submits into the TUI, while `run --goal` is headless.
  // prettier-ignore
  'gitlab-duo': { detectCmd: 'glab', launchCmd: 'glab duo cli', expectedProcess: 'duo', sharedLauncherCmd: true, promptInjectionMode: 'flag-interactive', interactivePromptFlag: '--goal' }
} satisfies Partial<Record<TuiAgent, TuiAgentConfigSource>>
