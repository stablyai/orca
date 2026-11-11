// @vitest-environment happy-dom
// RA-11b: right after a wake or app start main doesn't know the sandbox yet, so the first per-workspace
// Source read answers not_found. It retries when main's sandbox records change, not a minute later.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSourcesView } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  resetCloudRunningSignoutForTest,
  useWorkspaceUsesAccount
} from './cloud-running-agent-signout'

const ownAccount: AgentSourcesView = {
  defaults: {},
  coveredByKey: { claude: false, codex: false }
}

let runtimesChanged: (() => void) | null = null
const workspaceSources = vi.fn()

beforeEach(() => {
  resetCloudRunningSignoutForTest()
  runtimesChanged = null
  workspaceSources.mockReset()
  Object.assign(window, {
    api: {
      orcaCloudAgents: { workspaceSources },
      ephemeralVm: {
        onRuntimesChanged: (callback: () => void) => {
          runtimesChanged = callback
          return () => {
            runtimesChanged = null
          }
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  resetCloudRunningSignoutForTest()
})

describe('useWorkspaceUsesAccount after a wake (RA-11b)', () => {
  it('retries a not_found read as soon as main reports its sandbox records changed', async () => {
    workspaceSources.mockResolvedValueOnce({ ok: false, error: { code: 'not_found' } })
    const { result } = renderHook(() => useWorkspaceUsesAccount('env-1', 'claude', true, 1))
    await waitFor(() => expect(workspaceSources).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
    // Same account read (retryToken unchanged): only the sandbox record change can retry it.
    workspaceSources.mockResolvedValueOnce({ ok: true, value: ownAccount })
    act(() => runtimesChanged?.())
    await waitFor(() => expect(result.current).toBe(true))
    expect(workspaceSources).toHaveBeenCalledTimes(2)
  })

  it('a good answer is not re-read on every record change', async () => {
    workspaceSources.mockResolvedValue({ ok: true, value: ownAccount })
    const { result } = renderHook(() => useWorkspaceUsesAccount('env-1', 'claude', true, 1))
    await waitFor(() => expect(result.current).toBe(true))
    act(() => runtimesChanged?.())
    act(() => runtimesChanged?.())
    expect(workspaceSources).toHaveBeenCalledTimes(1)
  })

  it('stops watching main once no strip needs it', async () => {
    workspaceSources.mockResolvedValue({ ok: true, value: ownAccount })
    const { unmount } = renderHook(() => useWorkspaceUsesAccount('env-1', 'claude', true, 1))
    expect(runtimesChanged).not.toBeNull()
    unmount()
    expect(runtimesChanged).toBeNull()
  })
})
