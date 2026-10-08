import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdatePaneLayout } from '../../../shared/rpc-contract/session-tabs-schemas-params'
import { updateWebRuntimePaneLayout } from './web-runtime-terminal-actions'

const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'

vi.mock('../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => ENVIRONMENT_ID
}))

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
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  await expect(updateWebRuntimePaneLayout(args)).resolves.toBe(true)
  expect(runtimeCall).toHaveBeenCalledOnce()
  return runtimeCall.mock.calls[0][0].params
}

describe('updateWebRuntimePaneLayout intent marker', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends exactly the unmarked params when no intent is given', async () => {
    const params = await sentParams(LAYOUT)
    expect(Object.keys(params).sort()).toEqual(
      ['chatLeafId', 'expandedLeafId', 'root', 'tabId', 'titlesByLeafId', 'worktree'].sort()
    )
  })

  it('adds only the intent field for a gesture edit', async () => {
    const unmarked = await sentParams(LAYOUT)
    const marked = await sentParams({ ...LAYOUT, intent: 'gesture' })
    expect(marked).toEqual({ ...unmarked, intent: 'gesture' })
  })

  it('round-trips the marker through the host params schema', async () => {
    const marked = await sentParams({ ...LAYOUT, intent: 'gesture' })
    expect(UpdatePaneLayout.parse(marked).intent).toBe('gesture')
    expect(UpdatePaneLayout.parse({ ...marked, intent: 'unknown' }).intent).toBeUndefined()
  })
})
