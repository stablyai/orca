import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentCliUpdateHost } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { AgentCliUpdateStatusSegment } from './AgentCliUpdateStatusSegment'

const claude = {
  agent: 'claude',
  installedVersion: '2.1.250',
  latestVersion: '2.1.327',
  command: 'claude update',
  runnable: true
} as const
const codex = {
  agent: 'codex',
  installedVersion: '0.140.0',
  latestVersion: '0.170.0',
  command: 'codex update',
  runnable: true
} as const
const opencode = {
  agent: 'opencode',
  installedVersion: '1.19.5',
  latestVersion: '1.19.6',
  command: 'opencode upgrade',
  runnable: true
} as const
const copilot = {
  agent: 'copilot',
  installedVersion: '1.0.113',
  latestVersion: '1.0.114',
  command: 'copilot update',
  runnable: true
} as const
const cursor = {
  agent: 'cursor',
  installedVersion: '2026.11.12',
  latestVersion: '2026.11.17',
  command: 'cursor-agent update',
  runnable: true
} as const
const hermes = {
  agent: 'hermes',
  installedVersion: '0.23.0',
  latestVersion: '0.23.2',
  command: 'hermes update',
  runnable: false
} as const

const OUTPUT = [
  'Updating Codex via `npm install -g @openai/codex`...',
  'npm error code EACCES',
  'npm error syscall rename',
  'npm error path /usr/local/lib/node_modules/@openai/codex',
  'npm error errno -13',
  'npm error The operation was rejected by your operating system.'
].join('\n')

const buildServer: PublicKnownRuntimeEnvironment = {
  id: 'server-1',
  name: 'Build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://localhost:6768' }],
  preferredEndpointId: 'ws'
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

async function open(frame: HTMLElement): Promise<void> {
  frame.querySelector<HTMLButtonElement>('button')?.click()
  await settle()
}

function bar(hosts: [string, AgentCliUpdateHost][]) {
  return {
    width: 420,
    store: { agentCliUpdates: new Map(hosts) },
    render: () => (
      <div className="flex h-96 items-end justify-end bg-card p-2 text-foreground">
        <AgentCliUpdateStatusSegment />
      </div>
    )
  }
}

export const twoUpdates = defineFixture(bar([['', { updates: [claude, codex], runs: {} }]]))

export const twoUpdatesOpen = defineFixture({
  ...bar([['', { updates: [claude, codex], runs: {} }]]),
  interact: open
})

export const everyAgentOpen = defineFixture({
  ...bar([['', { updates: [claude, codex, opencode, copilot, cursor, hermes], runs: {} }]]),
  interact: open
})

export const oneUpdateOpen = defineFixture({
  ...bar([['', { updates: [claude], runs: {} }]]),
  interact: open
})

export const updating = defineFixture({
  ...bar([['', { updates: [claude, codex], runs: { claude: { phase: 'running' } } }]]),
  interact: open
})

export const failed = defineFixture({
  ...bar([
    [
      '',
      {
        updates: [claude, codex],
        runs: {
          codex: {
            phase: 'failed',
            output: OUTPUT,
            command: 'codex update',
            finishedAt: Date.UTC(2026, 10, 18, 18, 42)
          }
        }
      }
    ]
  ]),
  interact: open
})

export const manualCommand = defineFixture({
  ...bar([
    [
      '',
      {
        updates: [
          {
            ...codex,
            installedVersion: '0.120.0',
            command: 'npm install -g @openai/codex@latest',
            runnable: false
          }
        ],
        runs: {}
      }
    ]
  ]),
  interact: open
})

export const remoteHost = defineFixture({
  ...bar([
    ['', { updates: [claude], runs: {} }],
    ['server-1', { updates: [codex], runs: {} }]
  ]),
  store: {
    runtimeEnvironments: [buildServer],
    agentCliUpdates: new Map([
      ['', { updates: [claude], runs: {} }],
      ['server-1', { updates: [codex], runs: {} }]
    ])
  },
  interact: open
})
