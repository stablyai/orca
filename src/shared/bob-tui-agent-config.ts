import type { TuiAgentConfig } from './tui-agent-config-types'

export const BOB_TUI_AGENT_CONFIG = {
  detectCmd: 'bob',
  // Why: Bob Shell 2.x puts the TUI behind `chat` (bare `bob` only opens it on a TTY,
  // and `--auto-approve` is a `chat` option). `--trust` skips the first-launch folder prompt.
  launchCmd: 'bob chat --trust',
  expectedProcess: 'bob',
  // Why: MordechaiHadad/bob is a Neovim manager with the same executable name.
  detectIdentityExclusion: {
    args: ['--help'],
    excludePattern: /\bneo\s?vim\b|\bnvim\b/i,
    requirePattern: /Bob in your terminal|\bIBM\b|\bbob ?shell\b/i
  },
  // Why: `-p` and `run` are headless, so inject after the chat UI is up.
  promptInjectionMode: 'stdin-after-start',
  // Why: Bob emits no pre-input hook or generic terminal-mode anchor; its captures prove this marker.
  draftPasteReadySignal: 'bob-composer-prompt',
  composerReadyCaptures: ['bob-approval-command', 'bob-approval-subagent']
} satisfies TuiAgentConfig
