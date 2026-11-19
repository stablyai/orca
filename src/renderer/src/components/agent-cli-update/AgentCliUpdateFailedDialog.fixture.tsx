import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentCliUpdateHost } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import AgentCliUpdateFailedDialog from './AgentCliUpdateFailedDialog'

const OUTPUT = [
  'Updating Codex via `npm install -g @openai/codex`...',
  'npm error code EACCES',
  'npm error syscall rename',
  'npm error path /usr/local/lib/node_modules/@openai/codex',
  'npm error errno -13',
  "npm error Error: EACCES: permission denied, rename '/usr/local/lib/node_modules/@openai/codex' -> '/usr/local/lib/node_modules/@openai/.codex-x8Fq2'",
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

function failedOn(hostKey: string, command?: string) {
  const host: AgentCliUpdateHost = {
    updates: [
      {
        agent: 'codex',
        installedVersion: '0.140.0',
        latestVersion: '0.170.0',
        command: 'codex update',
        runnable: true
      }
    ],
    runs: {
      codex: {
        phase: 'failed',
        output: OUTPUT,
        ...(command ? { command } : {}),
        finishedAt: Date.UTC(2026, 10, 18, 18, 42)
      }
    }
  }
  return defineFixture({
    width: 640,
    store: {
      runtimeEnvironments: [buildServer],
      agentCliUpdates: new Map([[hostKey, host]]),
      activeModal: 'agent-cli-update-failed',
      modalData: { hostKey, agent: 'codex', tryAgain: () => {} }
    },
    render: () => <AgentCliUpdateFailedDialog />
  })
}

export const thisComputer = failedOn('', 'codex update')
export const pairedServer = failedOn('server-1', 'codex update')
export const nothingRan = failedOn('')
