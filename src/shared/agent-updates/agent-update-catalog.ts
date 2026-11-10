import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { PACKAGE_MANAGER_AGENT_UPDATES } from './agent-update-catalog-packages'
import type { AgentUpdateEntry } from './agent-update-types'

// Why: typed as a full Record so adding a TuiAgent without update info fails to compile.
export const AGENT_UPDATE_CATALOG: Record<TuiAgent, AgentUpdateEntry> = {
  claude: {
    latest: { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
    update: [{ via: 'self', args: ['update'] }]
  },
  'claude-agent-teams': { followsAgent: 'claude' },
  codex: {
    latest: { kind: 'npm', pkg: '@openai/codex' },
    update: [{ via: 'self', args: ['update'] }]
  },
  copilot: {
    versionArgs: ['version'],
    latest: { kind: 'npm', pkg: '@github/copilot' },
    update: [{ via: 'self', args: ['update'] }]
  },
  opencode: {
    sameMajorOnly: true,
    latest: { kind: 'npm', pkg: 'opencode-ai' },
    update: [{ via: 'self', args: ['upgrade'] }]
  },
  opencode2: {
    sameMajorOnly: true,
    latest: {
      kind: 'json',
      url: 'https://opencode.ai/update/api/latest/cli/npm',
      field: 'version'
    },
    update: [{ via: 'self', args: ['upgrade'] }]
  },
  droid: {
    latest: { kind: 'npm', pkg: 'droid' },
    update: [
      { via: 'npm', pkg: 'droid', when: ['npm'] },
      { via: 'self', args: ['update'], when: ['other'] }
    ]
  },
  kimi: {
    latest: { kind: 'npm', pkg: '@moonshot-ai/kimi-code' },
    update: [{ via: 'self', args: ['upgrade'] }]
  },
  aider: {
    latest: { kind: 'pypi', pkg: 'aider-chat' },
    update: [{ via: 'self', args: ['--upgrade'] }]
  },
  goose: {
    latest: { kind: 'github', repo: 'aaif-goose/goose' },
    update: [{ via: 'self', args: ['update'] }]
  },
  kilo: {
    latest: { kind: 'npm', pkg: '@kilocode/cli' },
    update: [{ via: 'self', args: ['upgrade'] }]
  },
  kiro: {
    latest: {
      kind: 'json',
      url: 'https://desktop-release.q.us-east-1.amazonaws.com/latest/manifest.json',
      field: 'version'
    },
    update: [{ via: 'self', args: ['update'] }]
  },
  aug: {
    sameMajorOnly: true,
    latest: { kind: 'npm', pkg: '@augmentcode/auggie' },
    update: [{ via: 'self', args: ['upgrade'] }]
  },
  'command-code': {
    latest: { kind: 'npm', pkg: 'command-code' },
    update: [{ via: 'self', args: ['update'] }]
  },
  codebuddy: {
    latest: { kind: 'npm', pkg: '@tencent-ai/codebuddy-code' },
    update: [{ via: 'self', args: ['update'] }]
  },
  ante: {
    latest: { kind: 'github', repo: 'AntigmaLabs/ante' },
    update: [{ via: 'self', args: ['update'] }]
  },
  dsh: {
    versionArgs: ['version'],
    latest: { kind: 'npm', pkg: '@deepseek-harness-tui/dsh-tui' },
    update: [{ via: 'self', args: ['update'] }]
  },
  pi: {
    latest: { kind: 'npm', pkg: '@earendil-works/pi-coding-agent' },
    update: [{ via: 'self', args: ['update'], when: ['other'] }]
  },
  omp: {
    latest: { kind: 'npm', pkg: '@oh-my-pi/pi-coding-agent' },
    update: [{ via: 'self', args: ['update'] }]
  },
  'prime-agent': {
    latest: { kind: 'github', repo: 'PrimeIntellect-ai/prime-agent' },
    update: [{ via: 'self', args: ['update'] }]
  },
  qoder: {
    latest: { kind: 'npm', pkg: '@qoder-ai/qodercli' },
    update: [{ via: 'self', args: ['update'] }]
  },
  'mistral-vibe': {
    latest: { kind: 'pypi', pkg: 'mistral-vibe' },
    update: [{ via: 'manual', command: 'vibe --check-upgrade' }]
  },
  hermes: {
    latest: { kind: 'github', repo: 'NousResearch/hermes-agent' },
    update: [{ via: 'self', args: ['update', '--yes'], when: ['other'] }]
  },
  openclaw: {
    latest: { kind: 'npm', pkg: 'openclaw' },
    update: [{ via: 'self', args: ['update'], when: ['npm', 'other'] }]
  },
  grok: {
    versionArgs: ['version'],
    latest: { kind: 'npm', pkg: '@xai-official/grok' },
    update: [{ via: 'self', args: ['update'] }]
  },
  jcode: {
    latest: { kind: 'github', repo: '1jehuang/jcode' },
    update: [{ via: 'self', args: ['update'] }]
  },
  amp: {
    scheme: 'amp-build',
    latest: { kind: 'text', url: 'https://static.ampcode.com/cli/cli-version.txt' },
    update: [{ via: 'self', args: ['update'] }]
  },
  trae: {
    latest: {
      kind: 'json',
      url: 'https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/public/stable/latest.json',
      field: 'version'
    },
    update: [{ via: 'manual', command: 'traecli update' }]
  },
  muse: {
    scheme: 'ignore-suffix',
    latest: {
      kind: 'json',
      url: 'https://api.meta.ai/muse-code/channels/muse-stable',
      field: 'version'
    },
    update: [
      {
        via: 'manual',
        command: 'curl -fsSL https://dev.meta.ai/install.sh | MUSE_UPGRADE_MODE=1 sh',
        platforms: ['darwin', 'linux']
      }
    ]
  },
  'mimo-code': {
    latest: { kind: 'github', repo: 'XiaomiMiMo/MiMo-Code' },
    update: [
      { via: 'self', args: ['upgrade', '-m', 'npm'], when: ['npm'] },
      { via: 'self', args: ['upgrade', '-m', 'curl'], when: ['app-bundle', 'other'] }
    ]
  },
  zcode: 'unsupported',
  ...PACKAGE_MANAGER_AGENT_UPDATES
}
