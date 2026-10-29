import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateWebRuntimePaneLayout } from './web-runtime-terminal-actions'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'

const store = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state }
})
vi.mock('../store', () => ({ useAppStore: { getState: () => store.state } }))

function ownedBy(...hostIds: ('local' | `runtime:${string}`)[]): Record<string, unknown> {
  return {
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) => ({
        id: WORKTREE_ID,
        repoId: 'repo',
        hostId,
        ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: ENVIRONMENT_ID })
      }))
    }
  }
}

const LAYOUT = {
  worktreeId: WORKTREE_ID,
  tabId: 'host-tab-1',
  root: {
    type: 'split' as const,
    direction: 'vertical' as const,
    ratio: 0.4,
    first: { type: 'leaf' as const, leafId: 'leaf-a' },
    second: { type: 'leaf' as const, leafId: 'leaf-b' }
  },
  expandedLeafId: null,
  chatLeafId: null,
  titlesByLeafId: { 'leaf-a': 'build' }
}

async function sentParams(
  args: Parameters<typeof updateWebRuntimePaneLayout>[0]
): Promise<Record<string, unknown>> {
  const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
  stubRuntimeEnvironmentBridge({ call: runtimeCall })
  await expect(updateWebRuntimePaneLayout(args)).resolves.toBe(true)
  expect(runtimeCall).toHaveBeenCalledOnce()
  return runtimeCall.mock.calls[0][0].params
}

describe('updateWebRuntimePaneLayout params', () => {
  beforeEach(() => {
    store.state = ownedBy(`runtime:${ENVIRONMENT_ID}`)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends exactly the layout params', async () => {
    const params = await sentParams(LAYOUT)
    expect(Object.keys(params).sort()).toEqual(
      ['chatLeafId', 'expandedLeafId', 'root', 'tabId', 'titlesByLeafId', 'worktree'].sort()
    )
  })

  it('refuses a local twin of the paired server and pushes nothing', async () => {
    store.state = ownedBy('local', `runtime:${ENVIRONMENT_ID}`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(updateWebRuntimePaneLayout(LAYOUT)).resolves.toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })
})
