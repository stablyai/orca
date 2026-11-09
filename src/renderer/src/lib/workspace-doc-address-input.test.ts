import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWorkspaceDocAddressTarget } from './workspace-doc-address-input'
import type { AppState } from '@/store/types'

const plan = vi.hoisted(() => ({
  result: { status: 'doc-preview' } as
    | { status: 'doc-preview' }
    | { status: 'browser-tab'; url: string; title: string }
    | { status: 'unsupported'; message: string; reason: 'no-channel' },
  calls: [] as { worktreeId: string; filePath: string }[]
}))
const hosts = vi.hoisted(() => new Map<string, string | null>())
const places = vi.hoisted(() => new Map<string, string>())
vi.mock('./workspace/ownership/resolve-owner', () => ({
  resolveOwner: (_state: unknown, ref: { workspaceId: string }) => {
    const environmentId = hosts.has(ref.workspaceId) ? hosts.get(ref.workspaceId) : 'server-1'
    return environmentId
      ? {
          kind: 'resolved',
          owner: {
            endpoint: { kind: 'environment', environmentId },
            at: places.get(ref.workspaceId) ?? 'local'
          }
        }
      : { kind: 'ambiguous' }
  }
}))
vi.mock('@/lib/file-preview', () => ({
  getWorkspaceFilePreviewPlan: (_state: unknown, worktreeId: string, filePath: string) => {
    plan.calls.push({ worktreeId, filePath })
    return plan.result
  }
}))

const CURRENT = 'repo1::/home/alice/wt1'
const OTHER = 'repo1::/home/alice/wt2'

function makeState(): AppState {
  return {
    getKnownWorktreeById: (id: string) =>
      id === CURRENT
        ? { id: CURRENT, path: '/home/alice/wt1' }
        : id === OTHER
          ? { id: OTHER, path: '/home/alice/wt2' }
          : undefined,
    allWorktrees: () => [
      { id: CURRENT, path: '/home/alice/wt1' },
      { id: OTHER, path: '/home/alice/wt2' }
    ],
    folderWorkspaces: [{ id: 'folder-1', folderPath: '/srv/site' }]
  } as unknown as AppState
}

beforeEach(() => {
  plan.result = { status: 'doc-preview' }
  plan.calls.length = 0
  hosts.clear()
  places.clear()
})

describe('resolveWorkspaceDocAddressTarget', () => {
  it('resolves a current-workspace address without enumerating unrelated workspace roots', () => {
    const state = makeState()
    state.allWorktrees = vi.fn(() => {
      throw new Error('unnecessary global workspace enumeration')
    })
    expect(
      resolveWorkspaceDocAddressTarget(state, CURRENT, '/home/alice/wt1/docs/index.html').status
    ).toBe('workspace-doc')
    expect(state.allWorktrees).not.toHaveBeenCalled()
  })
})
