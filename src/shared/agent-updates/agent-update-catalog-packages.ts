import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { AgentUpdateEntry } from './agent-update-types'

type PackageManagerAgent = Extract<
  TuiAgent,
  | 'gemini'
  | 'qwen-code'
  | 'cline'
  | 'codebuff'
  | 'freebuff'
  | 'continue'
  | 'openclaude'
  | 'autohand'
  | 'crush'
  | 'rovo'
  | 'qoder-cn'
  | 'cursor'
  | 'devin'
  | 'antigravity'
>

// Why: these agents have no self-update command, or install method decides the command.
export const PACKAGE_MANAGER_AGENT_UPDATES: Record<PackageManagerAgent, AgentUpdateEntry> = {
  gemini: {
    latest: { kind: 'npm', pkg: '@google/gemini-cli' },
    update: [{ via: 'npm', pkg: '@google/gemini-cli' }]
  },
  'qwen-code': {
    latest: { kind: 'npm', pkg: '@qwen-code/qwen-code' },
    update: [{ via: 'npm', pkg: '@qwen-code/qwen-code' }]
  },
  cline: {
    latest: { kind: 'npm', pkg: 'cline' },
    update: [{ via: 'npm', pkg: 'cline' }]
  },
  codebuff: {
    latest: { kind: 'npm', pkg: 'codebuff' },
    update: [{ via: 'npm', pkg: 'codebuff' }]
  },
  freebuff: {
    latest: { kind: 'npm', pkg: 'freebuff' },
    update: [{ via: 'npm', pkg: 'freebuff' }]
  },
  continue: {
    latest: { kind: 'npm', pkg: '@continuedev/cli' },
    update: [{ via: 'npm', pkg: '@continuedev/cli' }]
  },
  openclaude: {
    latest: { kind: 'npm', pkg: '@twigpine/openclaude' },
    update: [{ via: 'npm', pkg: '@twigpine/openclaude' }]
  },
  autohand: {
    latest: { kind: 'npm', pkg: 'autohand-cli' },
    update: [{ via: 'npm', pkg: 'autohand-cli' }]
  },
  crush: {
    latest: { kind: 'github', repo: 'charmbracelet/crush' },
    update: [
      { via: 'npm', pkg: '@charmland/crush', when: ['npm'] },
      {
        via: 'manual',
        command: 'go install github.com/charmbracelet/crush@latest'
      }
    ]
  },
  // Why: acli only ships through Homebrew, apt/yum or per-OS downloads; none is OS-independent.
  rovo: 'unsupported',
  'qoder-cn': {
    latest: { kind: 'npm', pkg: '@qodercn-ai/qoderclicn' },
    update: [{ via: 'npm', pkg: '@qodercn-ai/qoderclicn' }]
  },
  // Why: the install script pins the current `lab/<YYYY.MM.DD-hash>` build the CLI prints.
  cursor: {
    scheme: 'ignore-suffix',
    latest: {
      kind: 'text-regex',
      url: 'https://cursor.com/install',
      pattern: 'lab/(\\d{4}\\.\\d{2}\\.\\d{2}-[0-9a-f]+)'
    },
    update: [{ via: 'self', args: ['update'] }]
  },
  devin: {
    latest: {
      kind: 'json',
      url: 'https://static.devin.ai/cli/current/manifest.json',
      field: 'version'
    },
    update: [{ via: 'self', args: ['update'] }]
  },
  antigravity: {
    latest: { kind: 'github', repo: 'google-antigravity/antigravity-cli' },
    update: [
      {
        via: 'manual',
        command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        platforms: ['darwin', 'linux']
      },
      {
        via: 'manual',
        command: 'irm https://antigravity.google/cli/install.ps1 | iex',
        platforms: ['win32']
      }
    ]
  }
}
