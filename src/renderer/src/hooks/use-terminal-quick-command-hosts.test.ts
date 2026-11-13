// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalQuickCommands } from '@/store/terminals/quick-commands/terminal-quick-command-hosts'

const testState = vi.hoisted(() => ({
  executionHostId: 'runtime:build' as ExecutionHostId,
  loadRuntimeTerminalQuickCommands: vi.fn(async () => {}),
  resolveExecutionHostId: vi.fn(() => 'runtime:build' as ExecutionHostId),
  runtimeEnvironments: [] as { id: string; name: string }[],
  runtimeStatusByEnvironmentId: new Map<string, { connectionGeneration?: number }>(),
  runtimeTerminalQuickCommands: new Map<string, RuntimeTerminalQuickCommands>(),
  settings: null as GlobalSettings | null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof testState) => unknown) => {
    return selector(testState)
  }
}))

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => testState.resolveExecutionHostId()
}))

import {
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

  it('skips host resolution and remote loading while disabled', async () => {
    await act(async () => root.render(createElement(Probe, { enabled: false })))

    refreshRemoteHost()

    expect(renderedExecutionHostId).toBe('local')
    expect(renderedHosts).toEqual([])
    expect(remoteHostLoadFailed).toBe(false)
    expect(remoteHostPending).toBe(false)

    testState.executionHostId = 'runtime:other'
    await act(async () => root.render(createElement(Probe, { enabled: false })))
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
    }
  )
})
