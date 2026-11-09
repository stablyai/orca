import { defineFixture } from '../../component-fixtures/component-fixture'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import type { RuntimePortForward } from '../../../../shared/runtime-port-forwards'
import { LocalPortSection } from './local-port-section'
import { RuntimeForwardedPortsSection } from './runtime-forwarded-ports-section'
import {
  RuntimePortForwardStatus,
  type RuntimePortForwardRowState
} from './runtime-port-forward-status'

const owner = {
  worktreeId: 'w',
  repoId: 'r',
  displayName: 'w3-ports',
  path: '/home/vercel-sandbox/orca/workspaces/project/w3-ports',
  confidence: 'cwd' as const
}

function port(value: number, processName: string): WorkspacePort {
  return {
    id: `tcp:${value}`,
    kind: 'workspace',
    owner,
    bindHost: '127.0.0.1',
    connectHost: 'localhost',
    port: value,
    pid: 100 + value,
    processName,
    protocol: 'http'
  }
}

function forward(remotePort: number, patch: Partial<RuntimePortForward> = {}): RuntimePortForward {
  return {
    id: `f-${remotePort}`,
    environmentId: 'env',
    remotePort,
    localPort: remotePort,
    reason: 'auto',
    createdAt: 0,
    openConnections: 0,
    totalConnections: 3,
    bytesToHost: 0,
    bytesFromHost: 0,
    ...patch
  }
}

const ports = [
  port(5173, 'node'),
  port(3000, 'python3'),
  port(8080, 'java'),
  port(4000, 'ruby'),
  port(9229, 'node'),
  port(9000, 'go')
]
const states: Record<number, RuntimePortForwardRowState> = {
  5173: { kind: 'forwarded', forward: forward(5173) },
  3000: { kind: 'forwarded', forward: forward(3000, { localPort: 3001, reason: 'user' }) },
  8080: { kind: 'pending' },
  4000: { kind: 'failed', message: 'localhost:4000 busy', busy: true },
  9000: { kind: 'failed', message: 'Host unreachable', busy: false },
  9229: { kind: 'unforwarded' }
}

function Panel({ empty = false }: { empty?: boolean }): React.JSX.Element {
  return (
    <div className="w-[280px] bg-background pb-2">
      <LocalPortSection
        id="active"
        title="Active Workspace"
        ports={empty ? [] : ports}
        emptyText={
          empty
            ? 'No ports yet. Dev servers started here are forwarded to localhost.'
            : 'No ports detected'
        }
        collapsed={false}
        onToggle={() => {}}
        onStopPort={() => {}}
        onShowDetails={() => {}}
        onOpenInBrowser={() => {}}
        forwarding={{
          status: (row) => (
            <RuntimePortForwardStatus
              remotePort={row.port}
              state={states[row.port] ?? { kind: 'unforwarded' }}
              onForward={() => {}}
              onOpenLocal={() => {}}
            />
          ),
          menuItems: () => null,
          actions: () => null,
          copyAddress: (row) => {
            const state = states[row.port]
            return state?.kind === 'forwarded' ? `localhost:${state.forward.localPort}` : undefined
          }
        }}
      />
      <RuntimeForwardedPortsSection
        forwards={
          empty
            ? []
            : [
                forward(2222, { reason: 'ssh', localPort: 51022, openConnections: 1 }),
                forward(6006, { label: 'node', lastError: 'connect ECONNREFUSED' })
              ]
        }
      />
    </div>
  )
}

export const allStates = defineFixture({ width: 300, render: () => <Panel /> })
export const noPorts = defineFixture({ width: 300, render: () => <Panel empty /> })
export const unreachable = defineFixture({
  width: 300,
  render: () => (
    <div className="w-[280px] bg-background p-3">
      <RuntimePortForwardStatus
        remotePort={5173}
        state={{
          kind: 'forwarded',
          forward: forward(5173, { lastError: 'connect ECONNREFUSED 127.0.0.1:5173' })
        }}
        onForward={() => {}}
        onOpenLocal={() => {}}
      />
    </div>
  )
})
