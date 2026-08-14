// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalQuickCommands } from '@/store/slices/terminal-quick-command-hosts'

const testState = vi.hoisted(() => ({
  executionHostId: 'runtime:build' as ExecutionHostId,
  loadRuntimeTerminalQuickCommands: vi.fn(async () => {}),
  resolveExecutionHostId: vi.fn(() => 'runtime:build' as ExecutionHostId),
  runtimeEnvironments: [] as { id: string; name: string }[],
  runtimeStatusByEnvironmentId: new Map<string, { connectionGeneration?: number }>(),
  runtimeTerminalQuickCommands: new Map<string, RuntimeTerminalQuickCommands>(),
  settings: null as GlobalSettings | null,
  subscribedSelectors: [] as ((state: unknown) => unknown)[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof testState) => unknown) => {
    testState.subscribedSelectors.push(selector as (state: unknown) => unknown)
    return selector(testState)
  }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => testState.resolveExecutionHostId()
}))

import {
  flattenTerminalQuickCommandHosts,
  getTerminalQuickCommandHostOptions,
  shouldShowTerminalQuickCommandHostOwnership,
  useTerminalQuickCommandHosts,
  type TerminalQuickCommandHost
} from './use-terminal-quick-command-hosts'

let renderedHosts: TerminalQuickCommandHost[] = []
let renderedExecutionHostId: ExecutionHostId = 'local'
let refreshRemoteHost = (): void => {}
let remoteHostLoadFailed = false
let remoteHostPending = false

function Probe({ enabled = true }: { enabled?: boolean }): null {
  const result = useTerminalQuickCommandHosts('worktree-1', enabled)
  renderedExecutionHostId = result.executionHostId
  renderedHosts = result.hosts
  refreshRemoteHost = result.refreshRemoteHost
  remoteHostLoadFailed = result.remoteHostLoadFailed
  remoteHostPending = result.remoteHostPending
  return null
}

describe('useTerminalQuickCommandHosts', () => {
  let root: Root

  beforeEach(() => {
    testState.executionHostId = 'runtime:build'
    testState.loadRuntimeTerminalQuickCommands.mockClear()
    testState.resolveExecutionHostId.mockClear()
    testState.resolveExecutionHostId.mockImplementation(() => testState.executionHostId)
    testState.runtimeEnvironments = [{ id: 'build', name: 'Build Server' }]
    testState.runtimeStatusByEnvironmentId = new Map([['build', { connectionGeneration: 4 }]])
    testState.runtimeTerminalQuickCommands = new Map()
    testState.settings = getDefaultSettings('/tmp')
    testState.subscribedSelectors = []
    renderedHosts = []
    remoteHostLoadFailed = false
    remoteHostPending = false
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('shows ownership only when commands can come from multiple hosts', () => {
    expect(shouldShowTerminalQuickCommandHostOwnership([{ id: 'local' }])).toBe(false)
    expect(
      shouldShowTerminalQuickCommandHostOwnership([{ id: 'local' }, { id: 'runtime:build' }])
    ).toBe(true)
  })

  it('skips host resolution and remote loading while disabled', async () => {
    await act(async () => root.render(createElement(Probe, { enabled: false })))

    const disabledHosts = renderedHosts
    expect(testState.subscribedSelectors).toHaveLength(1)
    for (let write = 0; write < 1_000; write += 1) {
      testState.subscribedSelectors[0](testState)
    }
    refreshRemoteHost()

    expect(renderedExecutionHostId).toBe('local')
    expect(renderedHosts).toEqual([])
    expect(remoteHostLoadFailed).toBe(false)
    expect(remoteHostPending).toBe(false)
    expect(testState.resolveExecutionHostId).not.toHaveBeenCalled()
    expect(testState.loadRuntimeTerminalQuickCommands).not.toHaveBeenCalled()

    testState.executionHostId = 'runtime:other'
    await act(async () => root.render(createElement(Probe, { enabled: false })))

    expect(renderedHosts).toBe(disabledHosts)
    expect(testState.resolveExecutionHostId).not.toHaveBeenCalled()
    expect(testState.loadRuntimeTerminalQuickCommands).not.toHaveBeenCalled()

    testState.executionHostId = 'runtime:build'
    await act(async () => root.render(createElement(Probe)))

    expect(testState.resolveExecutionHostId).toHaveBeenCalledOnce()
    expect(testState.loadRuntimeTerminalQuickCommands).toHaveBeenCalledWith('build')
  })

  it.each([
    {
      name: 'unsupported',
      supported: false,
      generation: 4,
      expected: ['local'],
      pending: false
    },
    {
      name: 'stale generation',
      supported: true,
      generation: 3,
      expected: ['local'],
      pending: true
    },
    {
      name: 'supported current generation',
      supported: true,
      generation: 4,
      expected: ['local', 'runtime:build'],
      pending: false
    }
  ])(
    'gates the remote host when it is $name',
    async ({ supported, generation, expected, pending }) => {
      testState.runtimeTerminalQuickCommands = new Map([
        [
          'build',
          {
            commands: [],
            connectionGeneration: generation,
            error: null,
            loading: false,
            ready: true,
            supported
          }
        ]
      ])

      await act(async () => root.render(createElement(Probe)))

      expect(renderedHosts.map((host) => host.hostId)).toEqual(expected)
      expect(remoteHostPending).toBe(pending)
      expect(testState.loadRuntimeTerminalQuickCommands).toHaveBeenCalledWith('build')
    }
  )

  it('keeps mutations pending until remote capability ownership resolves', async () => {
    await act(async () => root.render(createElement(Probe)))

    expect(renderedHosts.map((host) => host.hostId)).toEqual(['local'])
    expect(remoteHostPending).toBe(true)
  })

  it('distinguishes an unresolved host failure from active loading', async () => {
    testState.runtimeTerminalQuickCommands = new Map([
      [
        'build',
        {
          commands: [],
          connectionGeneration: 4,
          error: 'offline',
          loading: false,
          ready: false,
          supported: null
        }
      ]
    ])

    await act(async () => root.render(createElement(Probe)))

    expect(remoteHostPending).toBe(true)
    expect(remoteHostLoadFailed).toBe(true)
  })
})

describe('flattenTerminalQuickCommandHosts', () => {
  it('keeps identical command ids distinct by owning host', () => {
    const command = {
      id: 'build',
      label: 'Build',
      action: 'terminal-command' as const,
      command: 'pnpm build',
      appendEnter: true,
      scope: { type: 'global' as const }
    }

    const entries = flattenTerminalQuickCommandHosts([
      { hostId: 'local', label: 'Local Mac', commands: [command] },
      { hostId: 'runtime:server', label: 'Build Server', commands: [command] }
    ])

    expect(entries.map((entry) => [entry.key, entry.hostLabel])).toEqual([
      ['local\0build', 'Local Mac'],
      ['runtime:server\0build', 'Build Server']
    ])
  })

  it('reuses execution-host registry names and rename overrides', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      hostSettingOverrides: {
        local: { displayLabel: 'Studio Mac' },
        'runtime:build': { displayLabel: 'Build Server' }
      }
    }

    expect(
      getTerminalQuickCommandHostOptions(settings, [{ id: 'build', name: 'Remote Mac' }])
    ).toEqual([
      { id: 'local', label: 'Studio Mac' },
      { id: 'runtime:build', label: 'Build Server' }
    ])
  })
})
