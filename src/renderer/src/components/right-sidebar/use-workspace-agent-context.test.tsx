// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextReport } from '../../../../shared/agent-context'

const testState = vi.hoisted(() => ({
  worktree: null as null | { id: string; path: string },
  runtimeTarget: { kind: 'local' } as unknown,
  pending: new Map<string, (report: AgentContextReport) => void>()
}))

vi.mock('@/store/selectors', () => ({ useActiveWorktree: () => testState.worktree }))
vi.mock('@/hooks/use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => testState.runtimeTarget
}))
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ discoveryTarget: { runtime: 'native-host' } })
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  useInstalledAgentSkillNames: () => ({
    skills: [],
    sources: [],
    loading: false,
    refresh: async () => true
  })
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

  it('clears the report and stops loading without a worktree', () => {
    testState.worktree = null
    act(() => root.render(<Probe />))
    expect(latest?.report).toBeNull()
    expect(latest?.loading).toBe(false)
    expect(latest?.worktreePath).toBeNull()
  })
})
