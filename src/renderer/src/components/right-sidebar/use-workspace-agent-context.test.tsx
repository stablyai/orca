// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextReport } from '../../../../shared/agent-context'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const testState = vi.hoisted(() => ({
  worktree: null as null | { id: string; path: string },
  hostKind: 'local' as 'local' | 'runtime' | 'ssh' | 'unresolved',
  pending: new Map<string, (report: AgentContextReport) => void>()
}))

vi.mock('@/store/selectors', () => ({ useActiveWorktree: () => testState.worktree }))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: unknown) => T): T => selector({})
}))
vi.mock('@/components/native-chat/native-chat-skill-discovery-context', () => ({
  selectNativeChatSkillStateInputs: (state: unknown) => state
}))
vi.mock('./workspace-context-target', () => ({
  resolveWorkspaceExecutionHostId: () => 'local',
  resolveWorkspaceContextTarget: (_state: unknown, worktreeId: string | null) => {
    if (!worktreeId || !testState.worktree || testState.hostKind === 'unresolved') {
      return null
    }
    const cwd = testState.worktree.path
    return {
      key: JSON.stringify([testState.hostKind, cwd]),
      cwd,
      executionHostKind: testState.hostKind,
      runtimeTarget: { kind: 'local' },
      discoveryTarget: { cwd, worktreeId }
    }
  }
}))
vi.mock('@/runtime/runtime-skills-client', () => ({
  // Why: skills stay pending; these tests watch the report path.
  discoverSkillsForRuntimeTarget: () => new Promise(() => {})
}))
vi.mock('@/runtime/runtime-agent-context-client', () => ({
  inspectAgentContextForRuntimeTarget: (_runtime: unknown, target: { cwd: string }) =>
    new Promise<AgentContextReport>((resolve) => {
      testState.pending.set(target.cwd, resolve)
    })
}))

import {
  useWorkspaceAgentContext,
  type WorkspaceAgentContextState
} from './use-workspace-agent-context'

function reportFor(cwd: string): AgentContextReport {
  return {
    target: { kind: 'native-host', homeDir: '/home/u', cwd },
    instructionFiles: [],
    mcpFiles: [],
    hookFiles: [],
    plugins: [],
    scannedAt: 1
  }
}

describe('useWorkspaceAgentContext', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: WorkspaceAgentContextState | null = null

  function Probe(): null {
    latest = useWorkspaceAgentContext()
    return null
  }

  beforeEach(() => {
    testState.hostKind = 'local'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    testState.pending.clear()
    latest = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('never shows the previous workspace report after a switch, even if its scan lands later', async () => {
    testState.worktree = { id: 'a', path: '/w/a' }
    act(() => root.render(<Probe />))
    expect(latest?.loading).toBe(true)
    expect(latest?.report).toBeNull()

    testState.worktree = { id: 'b', path: '/w/b' }
    act(() => root.render(<Probe />))
    expect(latest?.report).toBeNull()

    await act(async () => {
      testState.pending.get('/w/a')?.(reportFor('/w/a'))
    })
    expect(latest?.report).toBeNull()
    expect(latest?.loading).toBe(true)

    await act(async () => {
      testState.pending.get('/w/b')?.(reportFor('/w/b'))
    })
    expect(latest?.report?.target.cwd).toBe('/w/b')
    expect(latest?.loading).toBe(false)
  })

  it('names why nothing can be read for SSH and unresolved-runtime workspaces', () => {
    testState.worktree = { id: 'a', path: '/w/a' }
    testState.hostKind = 'ssh'
    act(() => root.render(<Probe />))
    expect(latest?.unavailable).toBe('ssh')
    expect(latest?.loading).toBe(false)
    expect(testState.pending.size).toBe(0)

    testState.hostKind = 'unresolved'
    testState.worktree = { id: 'b', path: '/w/b' }
    act(() => root.render(<Probe />))
    expect(latest?.unavailable).toBe('runtime-unresolved')
    expect(latest?.report).toBeNull()
  })

  it('clears the report and stops loading without a worktree', () => {
    testState.worktree = null
    act(() => root.render(<Probe />))
    expect(latest?.report).toBeNull()
    expect(latest?.loading).toBe(false)
    expect(latest?.worktreePath).toBeNull()
  })
})
