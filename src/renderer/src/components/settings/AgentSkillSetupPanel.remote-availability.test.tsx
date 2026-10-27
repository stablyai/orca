// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { planEntry, planOf, planOp } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ capability: vi.fn(), rpc: vi.fn() }))
const TARGET = { kind: 'environment', environmentId: 'managed-ssh' } as const

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: TARGET
  })
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: mocks.capability,
  callRuntimeRpc: mocks.rpc
}))

const response = createCompatibleRuntimeStatusResponse('host-runtime')
const HOST_STATUS = response.ok ? response.result : null

const PLAN = planOf([
  planEntry('orchestration', [
    planOp('keep', '/home/u/.agents/skills/orchestration', {
      agents: ['codex'],
      observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) }
    }),
    planOp('link', '/home/u/.claude/skills/orchestration')
  ])
])

let root: Root | null = null
let container: HTMLDivElement | null = null

function setHostConnected(connected: boolean): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [
        TARGET.environmentId,
        {
          status: connected ? HOST_STATUS : null,
          checkedAt: 1,
          snapshot: {
            environmentId: TARGET.environmentId,
            pairingRevision: 1,
            sequence: connected ? 2 : 3,
            checkedAt: 1,
            status: connected ? HOST_STATUS : null,
            verification: connected ? 'verified' : 'blocked',
            transport: connected ? 'ready' : 'disconnected',
            ...(connected ? {} : { retired: true })
          }
        }
      ]
    ])
  })
}

async function renderPanel(installed = false): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <AgentSkillSetupPanel
        title="Orchestration skill"
        description={null}
        skillNames={['orchestration']}
        installed={installed}
        loading={false}
        error={null}
        onRecheck={() => {}}
      />
    )
  })
}

function buttonLabels(): string[] {
  return Array.from(
    container?.querySelectorAll('button') ?? [],
    (button) => button.textContent?.trim() ?? ''
  )
}

describe('remote skill setup availability', () => {
  beforeEach(() => {
    mocks.capability.mockReset().mockResolvedValue(true)
    mocks.rpc.mockReset().mockResolvedValue(PLAN)
    useAppStore.setState({
      runtimeEnvironments: [
        {
          id: TARGET.environmentId,
          name: 'SSH host',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: 'host-runtime',
          endpoints: [
            {
              id: 'ssh',
              kind: 'websocket',
              label: 'SSH tunnel',
              endpoint: 'ws://127.0.0.1:1234'
            }
          ],
          preferredEndpointId: 'ssh',
          connectionDependency: 'ssh-tunnel',
          orcadDeployment: {
            sshTargetId: 'box',
            sshTargetGeneration: 1,
            localPort: 1234,
            remotePort: 1234
          }
        }
      ]
    })
    setHostConnected(true)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    container?.remove()
    container = null
    useAppStore.setState({ runtimeEnvironments: [], runtimeStatusByEnvironmentId: new Map() })
  })

  it.each([false, true])(
    'shows a manually disconnected host before any click (discovery installed: %s)',
    async (installed) => {
      setHostConnected(false)
      await renderPanel(installed)

      expect(container?.textContent).toContain('Connect to this SSH host to install its skills.')
      expect(container?.textContent).not.toContain('Not installed')
      expect(buttonLabels()).toEqual(['Re-check'])
      expect(mocks.capability).not.toHaveBeenCalled()
      expect(mocks.rpc).not.toHaveBeenCalled()
    }
  )

  it('withdraws a connected plan immediately on disconnect and replans on reconnect', async () => {
    await renderPanel()
    expect(buttonLabels()).toContain('Install for Claude Code')

    await act(async () => setHostConnected(false))
    expect(container?.textContent).toContain('Connect to this SSH host to install its skills.')
    expect(buttonLabels()).toEqual(['Re-check'])

    mocks.rpc.mockResolvedValue(
      planOf([
        planEntry('orchestration', [
          planOp('keep', '/home/u/.agents/skills/orchestration', {
            agents: ['codex', 'claude'],
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) }
          })
        ])
      ])
    )
    await act(async () => setHostConnected(true))
    expect(container?.textContent).not.toContain('Connect to this SSH host')
    expect(buttonLabels()).toEqual(['Re-check'])
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('shows a failed host check without claiming the skill is absent or offering installation', async () => {
    mocks.capability.mockRejectedValue(new Error('Runtime environment is manually disconnected.'))
    await renderPanel()

    expect(container?.textContent).toContain('Check failed')
    expect(container?.textContent).not.toContain('Not installed')
    expect(buttonLabels()).toEqual(['Re-check'])
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
