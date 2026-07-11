// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLinearMetadataCache,
  useTeamLabels,
  useTeamMembers,
  useTeamStates
} from './useIssueMetadata'

const linearMocks = vi.hoisted(() => ({
  linearTeamStates: vi.fn(),
  linearTeamLabels: vi.fn(),
  linearTeamMembers: vi.fn()
}))

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearTeamStates: linearMocks.linearTeamStates,
  linearTeamLabels: linearMocks.linearTeamLabels,
  linearTeamMembers: linearMocks.linearTeamMembers
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: (settings?: { activeRuntimeEnvironmentId?: string | null } | null) =>
    settings?.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))

const roots: Root[] = []

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderProbe(element: React.ReactNode): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(element)
  })
}

describe('useIssueMetadata Linear hooks', () => {
  beforeEach(() => {
    clearLinearMetadataCache()
    linearMocks.linearTeamStates.mockReset()
    linearMocks.linearTeamLabels.mockReset()
    linearMocks.linearTeamMembers.mockReset()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('does not loop when cached team-state metadata is read with a fresh settings object', async () => {
    let renders = 0
    let states: unknown[] = []
    linearMocks.linearTeamStates.mockResolvedValue([{ id: 's1', name: 'Todo' }])

    function StatesProbe(): null {
      renders += 1
      // Fresh settings object each render — the storm trigger.
      const metadata = useTeamStates('team-1', { activeRuntimeEnvironmentId: null }, 'ws-1')
      states = metadata.data
      return null
    }

    renderProbe(<StatesProbe />)
    await flushEffects()

    expect(states).toEqual([{ id: 's1', name: 'Todo' }])
    expect(linearMocks.linearTeamStates).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('does not re-issue a failed team-state fetch when a fresh settings object re-renders', async () => {
    let renders = 0
    let error: string | null = null
    linearMocks.linearTeamStates.mockRejectedValue(new Error('Could not connect'))

    function StatesProbe(): null {
      renders += 1
      const metadata = useTeamStates('team-1', { activeRuntimeEnvironmentId: null }, 'ws-1')
      error = metadata.error
      return null
    }

    renderProbe(<StatesProbe />)
    await flushEffects()
    await flushEffects()
    await flushEffects()

    expect(error).toBe('Could not connect')
    expect(linearMocks.linearTeamStates).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('does not re-issue a failed team-label fetch when a fresh settings object re-renders', async () => {
    let renders = 0
    let error: string | null = null
    linearMocks.linearTeamLabels.mockRejectedValue(new Error('Could not connect'))

    function LabelsProbe(): null {
      renders += 1
      const metadata = useTeamLabels('team-1', { activeRuntimeEnvironmentId: null }, 'ws-1')
      error = metadata.error
      return null
    }

    renderProbe(<LabelsProbe />)
    await flushEffects()
    await flushEffects()
    await flushEffects()

    expect(error).toBe('Could not connect')
    expect(linearMocks.linearTeamLabels).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('does not re-issue a failed team-member fetch when a fresh settings object re-renders', async () => {
    let renders = 0
    let error: string | null = null
    linearMocks.linearTeamMembers.mockRejectedValue(new Error('Could not connect'))

    function MembersProbe(): null {
      renders += 1
      const metadata = useTeamMembers('team-1', { activeRuntimeEnvironmentId: null }, 'ws-1')
      error = metadata.error
      return null
    }

    renderProbe(<MembersProbe />)
    await flushEffects()
    await flushEffects()
    await flushEffects()

    expect(error).toBe('Could not connect')
    expect(linearMocks.linearTeamMembers).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })
})
