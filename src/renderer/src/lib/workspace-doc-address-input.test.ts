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
})

describe('resolveWorkspaceDocAddressTarget', () => {
  it('resolves an absolute path inside the current worktree to its document', () => {
    const target = resolveWorkspaceDocAddressTarget(
      makeState(),
      CURRENT,
      '/home/alice/wt1/docs/report.html'
    )
    expect(target).toEqual({
      status: 'workspace-doc',
      docLocation: {
        kind: 'workspace-doc',
        worktreeId: CURRENT,
        filePath: '/home/alice/wt1/docs/report.html'
      }
    })
  })

  it('falls back to another known worktree only when the current one does not contain the path', () => {
    const target = resolveWorkspaceDocAddressTarget(
      makeState(),
      CURRENT,
      '/home/alice/wt2/index.html'
    )
    expect(target).toMatchObject({
      status: 'workspace-doc',
      docLocation: { worktreeId: OTHER, filePath: '/home/alice/wt2/index.html' }
    })
  })

  // Why most-specific-first: the outer root lexically contains the nested workspace's files, and
  // attributing them to it selects the wrong owner — and so the wrong host — for the grant.
  it('attributes a file in a nested workspace to the nested root, not the outer one', () => {
    const state = makeState()
    const stateWithNested = {
      ...state,
      allWorktrees: () => [...state.allWorktrees(), { id: 'repo2::/srv', path: '/srv' }]
    } as typeof state

    const target = resolveWorkspaceDocAddressTarget(
      stateWithNested,
      CURRENT,
      '/srv/site/index.html'
    )

    expect(target).toMatchObject({
      status: 'workspace-doc',
      docLocation: { worktreeId: 'folder:folder-1' }
    })
  })

  it('resolves a folder workspace root under its folder key', () => {
    const target = resolveWorkspaceDocAddressTarget(makeState(), CURRENT, '/srv/site/index.html')
    expect(target).toMatchObject({
      status: 'workspace-doc',
      docLocation: { worktreeId: 'folder:folder-1', filePath: '/srv/site/index.html' }
    })
  })

  it('leaves a path outside every known workspace to the URL pipeline', () => {
    expect(resolveWorkspaceDocAddressTarget(makeState(), CURRENT, '/etc/motd.html')).toEqual({
      status: 'not-a-workspace-doc'
    })
  })

  it('resolves a ./ relative path against the current worktree', () => {
    const target = resolveWorkspaceDocAddressTarget(makeState(), CURRENT, './docs/report.html')
    expect(target).toMatchObject({
      status: 'workspace-doc',
      docLocation: { worktreeId: CURRENT, filePath: '/home/alice/wt1/docs/report.html' }
    })
  })

  // Containment is lexical, so dot segments are refused rather than resolved.
  it('refuses dot segments in both the relative and the absolute form', () => {
    expect(resolveWorkspaceDocAddressTarget(makeState(), CURRENT, './a/../../etc/x.html')).toEqual({
      status: 'not-a-workspace-doc'
    })
    expect(
      resolveWorkspaceDocAddressTarget(makeState(), CURRENT, '/home/alice/wt1/../wt9/x.html')
    ).toEqual({ status: 'not-a-workspace-doc' })
  })

  // "docs/report.html" is indistinguishable from a hostname with a path.
  it('leaves bare relative text and non-previewable extensions to the URL pipeline', () => {
    expect(resolveWorkspaceDocAddressTarget(makeState(), CURRENT, 'docs/report.html')).toEqual({
      status: 'not-a-workspace-doc'
    })
    expect(
      resolveWorkspaceDocAddressTarget(makeState(), CURRENT, '/home/alice/wt1/notes.md')
    ).toEqual({ status: 'not-a-workspace-doc' })
    expect(plan.calls).toEqual([])
  })

  it('keeps a local file on the file:// pipeline and surfaces an unsupported plan as its message', () => {
    plan.result = { status: 'browser-tab', url: 'file:///x', title: 'x' }
    expect(
      resolveWorkspaceDocAddressTarget(makeState(), CURRENT, '/home/alice/wt1/x.html')
    ).toEqual({ status: 'not-a-workspace-doc' })

    plan.result = { status: 'unsupported', message: 'no channel', reason: 'no-channel' }
    expect(
      resolveWorkspaceDocAddressTarget(makeState(), CURRENT, '/home/alice/wt1/x.html')
    ).toEqual({ status: 'unsupported', message: 'no channel' })
  })
})
