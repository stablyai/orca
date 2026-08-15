import type { TuiAgent } from './types'

export type AgentInstallPlatform = 'darwin' | 'linux' | 'win32'

export type TuiAgentInstallSpec = {
  agent: TuiAgent
  /** Official non-interactive install commands keyed by host platform. */
  commandByPlatform: Partial<Record<AgentInstallPlatform, string>>
  /**
   * Binary name used for pre/post install PATH checks. Defaults to the agent's
   * `detectCmd` from TUI_AGENT_CONFIG.
   */
  verifyCmd?: string
}

// Why: only agents with documented unattended installers ship here. Interactive
// or docs-only installers stay out so remote auto-install cannot hang or run
// untrusted client shell. Commands are server-selected by agent id — never
// accepted as freeform client text.
export const TUI_AGENT_INSTALL_SPECS: readonly TuiAgentInstallSpec[] = [
  {
    agent: 'claude',
    commandByPlatform: {
      darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash',
      win32: 'irm https://claude.ai/install.ps1 | iex'
    }
  },
  {
    agent: 'codex',
    commandByPlatform: {
      darwin: 'npm install -g @openai/codex',
      linux: 'npm install -g @openai/codex',
      win32: 'npm install -g @openai/codex'
    }
  },
  {
    agent: 'opencode',
    commandByPlatform: {
      darwin: 'curl -fsSL https://opencode.ai/install | bash',
      linux: 'curl -fsSL https://opencode.ai/install | bash',
      win32: 'npm install -g opencode-ai'
    }
  },
  {
    agent: 'pi',
    commandByPlatform: {
      darwin: 'curl -fsSL https://pi.dev/install.sh | sh',
      linux: 'curl -fsSL https://pi.dev/install.sh | sh',
      win32: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
    }
  },
  {
    agent: 'grok',
    commandByPlatform: {
      darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash',
      linux: 'curl -fsSL https://x.ai/cli/install.sh | bash'
    }
  },
  {
    agent: 'droid',
    commandByPlatform: {
      darwin: 'curl -fsSL https://app.factory.ai/cli | sh',
      linux: 'curl -fsSL https://app.factory.ai/cli | sh',
      win32: 'irm https://app.factory.ai/cli/windows | iex'
    }
  },
  {
    agent: 'gemini',
    commandByPlatform: {
      darwin: 'npm install -g @google/gemini-cli',
      linux: 'npm install -g @google/gemini-cli',
      win32: 'npm install -g @google/gemini-cli'
    }
  },
  {
    agent: 'copilot',
    commandByPlatform: {
      darwin: 'npm install -g @github/copilot',
      linux: 'npm install -g @github/copilot',
      win32: 'npm install -g @github/copilot'
    }
  },
  {
    agent: 'command-code',
    commandByPlatform: {
      darwin: 'npm install -g command-code',
      linux: 'npm install -g command-code',
      win32: 'npm install -g command-code'
    }
  },
  {
    agent: 'openclaude',
    commandByPlatform: {
      darwin: 'npm install -g @gitlawb/openclaude@latest',
      linux: 'npm install -g @gitlawb/openclaude@latest',
      win32: 'npm install -g @gitlawb/openclaude@latest'
    }
  },
  {
    agent: 'mimo-code',
    commandByPlatform: {
      darwin: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
      linux: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
      win32: 'powershell -ep Bypass -c "irm https://mimo.xiaomi.com/install.ps1 | iex"'
    }
  },
  {
    agent: 'ante',
    commandByPlatform: {
      darwin: 'curl -fsSL https://ante.run/install.sh | bash',
      linux: 'curl -fsSL https://ante.run/install.sh | bash'
    }
  },
  {
    agent: 'antigravity',
    commandByPlatform: {
      darwin: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      win32: 'irm https://antigravity.google/cli/install.ps1 | iex'
    }
  },
  {
    agent: 'amp',
    commandByPlatform: {
      darwin: 'curl -fsSL https://ampcode.com/install.sh | bash',
      linux: 'curl -fsSL https://ampcode.com/install.sh | bash',
      win32: 'powershell -c "irm https://ampcode.com/install.ps1 | iex"'
    }
  },
  {
    agent: 'kilo',
    commandByPlatform: {
      darwin: 'npm install -g @kilocode/cli',
      linux: 'npm install -g @kilocode/cli',
      win32: 'npm install -g @kilocode/cli'
    }
  },
  {
    agent: 'kiro',
    commandByPlatform: {
      darwin: 'curl -fsSL https://cli.kiro.dev/install | bash',
      linux: 'curl -fsSL https://cli.kiro.dev/install | bash',
      win32: 'curl -fsSL https://cli.kiro.dev/install | bash'
    }
  },
  {
    agent: 'crush',
    commandByPlatform: {
      darwin: 'npm install -g @charmland/crush',
      linux: 'npm install -g @charmland/crush',
      win32: 'npm install -g @charmland/crush'
    }
  },
  {
    agent: 'aug',
    commandByPlatform: {
      darwin: 'npm install -g @augmentcode/auggie',
      linux: 'npm install -g @augmentcode/auggie',
      win32: 'npm install -g @augmentcode/auggie'
    }
  },
  {
    agent: 'autohand',
    commandByPlatform: {
      darwin: 'curl -fsSL https://autohand.ai/install.sh | sh',
      linux: 'curl -fsSL https://autohand.ai/install.sh | sh',
      win32: 'npm install -g autohand-cli'
    }
  },
  {
    agent: 'cline',
    commandByPlatform: {
      darwin: 'npm install -g cline',
      linux: 'npm install -g cline',
      win32: 'npm install -g cline'
    }
  },
  {
    agent: 'codebuff',
    commandByPlatform: {
      darwin: 'npm install -g codebuff',
      linux: 'npm install -g codebuff',
      win32: 'npm install -g codebuff'
    }
  },
  {
    agent: 'continue',
    commandByPlatform: {
      darwin: 'npm install -g @continuedev/cli',
      linux: 'npm install -g @continuedev/cli',
      win32: 'npm install -g @continuedev/cli'
    }
  },
  {
    agent: 'kimi',
    commandByPlatform: {
      darwin: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
      linux: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
      win32: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex'
    }
  },
  {
    agent: 'mistral-vibe',
    commandByPlatform: {
      darwin: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
      linux: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
      win32: 'uv tool install mistral-vibe'
    }
  },
  {
    agent: 'qwen-code',
    commandByPlatform: {
      darwin: 'npm install -g @qwen-code/qwen-code@latest',
      linux: 'npm install -g @qwen-code/qwen-code@latest',
      win32: 'npm install -g @qwen-code/qwen-code@latest'
    }
  },
  {
    agent: 'omp',
    commandByPlatform: {
      darwin: 'curl -fsSL https://omp.sh/install | sh',
      linux: 'curl -fsSL https://omp.sh/install | sh',
      win32: 'irm https://omp.sh/install.ps1 | iex'
    }
  },
  {
    agent: 'devin',
    commandByPlatform: {
      darwin: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
      linux: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
      win32: 'irm https://static.devin.ai/cli/setup.ps1 | iex'
    }
  },
  {
    agent: 'cursor',
    commandByPlatform: {
      // Why: official Cursor Agent installer; native Windows host support is
      // limited — prefer WSL/Linux remotes for unattended install.
      darwin: 'curl https://cursor.com/install -fsSL | bash',
      linux: 'curl https://cursor.com/install -fsSL | bash'
    }
  },
  {
    agent: 'goose',
    commandByPlatform: {
      // Why: default goose install opens interactive provider config; CONFIGURE=false
      // keeps remote auto-install non-interactive (user still configures later).
      darwin:
        'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
      linux:
        'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash'
    }
  }
] as const
