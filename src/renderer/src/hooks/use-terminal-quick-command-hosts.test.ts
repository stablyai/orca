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
  settings: null as GlobalSettings | null,
  subscribedSelectors: [] as ((state: unknown) => unknown)[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof testState) => unknown) => {
    testState.subscribedSelectors.push(selector as (state: unknown) => unknown)
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

function Probe(): null {
  renderedHosts = useTerminalQuickCommandHosts('worktree-1', true).hosts
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
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  it('an Orca Cloud workspace offers only its sandbox, even before its commands load (JA-31)', async () => {
    testState.runtimeEnvironments = [{ id: 'build', name: 'Hello-World sandbox abcd1234' }]
    Object.assign(testState.runtimeEnvironments[0], { source: 'ephemeral-vm' })
    await act(async () => root.render(createElement(Probe)))
    expect(renderedHosts.map((host) => host.hostId)).toEqual(['runtime:build'])
    expect(renderedHosts[0]?.commands).toEqual([])
  })
})
