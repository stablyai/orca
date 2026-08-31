import { describe, expect, it } from 'vitest'
import { planBrowserWorkspaceTabClose } from './browser-workspace-tab-close-plan'
import { getBrowserWorkspaceRemoteOwnership } from './remote-browser-tab-ownership'

function state(pages: { id: string; environmentId?: string; staged?: true }[]): never {
  return {
    browserPagesByWorkspace: {
      'workspace-a': pages.map((page) => ({ id: page.id, browserRuntimeEnvironmentId: null }))
    },
    remoteBrowserPageHandlesByPageId: Object.fromEntries(
      pages
        .filter((page) => page.environmentId)
        .map((page) => [
          page.id,
          {
            environmentId: page.environmentId,
            remotePageId: `remote-${page.id}`,
            ...(page.staged ? { staged: true } : {})
          }
        ])
    )
  } as never
}

function plan(
  pages: { id: string; environmentId?: string; staged?: true }[],
  options: { focusedEnvironmentId?: string | null; activeEnvironmentIds?: string[] } = {}
): ReturnType<typeof planBrowserWorkspaceTabClose> {
  const active = new Set(options.activeEnvironmentIds ?? [])
  return planBrowserWorkspaceTabClose({
    state: state(pages),
    workspaceId: 'workspace-a',
    focusedEnvironmentId: options.focusedEnvironmentId ?? null,
    isEnvironmentActive: (environmentId) => Boolean(environmentId && active.has(environmentId))
  })
}

describe('planBrowserWorkspaceTabClose', () => {
  // Why: a staged page names its environment before the host has minted the page, so without this
  // case the owner branch closes a tab id the host has never heard of — the X does nothing and the
  // in-flight create's snapshot then puts the tab back.
  it('unwinds a staged tab locally instead of closing it on a host that has not created it', () => {
    expect(
      plan([{ id: 'page-1', environmentId: 'env-a', staged: true }], {
        activeEnvironmentIds: ['env-a']
      })
    ).toEqual({
      hostEnvironmentIds: [],
      closesLocally: true,
      removesVisibleTab: true,
      localCloseReason: 'cleanup'
    })
  })

  // Why: adoption is exactly the moment ownership transfers, and it is the snapshot clearing the
  // staged flag that marks it — the same workspace must flip from a local unwind to a host close.
  it('hands the same workspace back to its host once adoption clears the staged flag', () => {
    const staged = plan([{ id: 'page-1', environmentId: 'env-a', staged: true }], {
      activeEnvironmentIds: ['env-a']
    })
    const adopted = plan([{ id: 'page-1', environmentId: 'env-a' }], {
      activeEnvironmentIds: ['env-a']
    })

    expect(staged.closesLocally).toBe(true)
    expect(adopted).toEqual({
      hostEnvironmentIds: ['env-a'],
      closesLocally: false,
      removesVisibleTab: false
    })
    expect(adopted.localCloseReason).toBeUndefined()
  })

  // Why: the cleanup reason is what keeps an unwound create out of the reopen stack and off the
  // empty-worktree landing, so no ordinary local teardown may carry it.
  it('marks only the staged case as a cleanup close', () => {
    expect(plan([{ id: 'page-1' }]).localCloseReason).toBeUndefined()
    expect(
      plan([{ id: 'page-1', environmentId: 'env-a' }], { activeEnvironmentIds: [] })
        .localCloseReason
    ).toBeUndefined()
  })

  it('closes a single owner on its host and leaves the tab for host sync to remove', () => {
    expect(
      plan([{ id: 'page-1', environmentId: 'env-a' }], { activeEnvironmentIds: ['env-a'] })
    ).toEqual({
      hostEnvironmentIds: ['env-a'],
      closesLocally: false,
      removesVisibleTab: false
    })
  })

  // Why: this is the dead end — a workspace spanning two environments used to resolve as
  // "ambiguous" and the close fell through silently, leaving the X inert.
  it('closes every environment holding part of the workspace', () => {
    const result = plan(
      [
        { id: 'page-1', environmentId: 'env-a' },
        { id: 'page-2', environmentId: 'env-b' }
      ],
      { activeEnvironmentIds: ['env-a', 'env-b'] }
    )

    // Why: the plan promises no ordering, so only the owner set is sorted — the rest of the shape
    // is asserted whole, including that the connected hosts still own the mirror removal.
    expect({ ...result, hostEnvironmentIds: [...result.hostEnvironmentIds].sort() }).toEqual({
      hostEnvironmentIds: ['env-a', 'env-b'],
      closesLocally: false,
      removesVisibleTab: false
    })
  })

  it('skips an owner whose session is not connected, and still closes the ones that are', () => {
    const result = plan(
      [
        { id: 'page-1', environmentId: 'env-a' },
        { id: 'page-2', environmentId: 'env-b' }
      ],
      { activeEnvironmentIds: ['env-b'] }
    )

    // Why: the connected owner removes the mirror through tab sync, so the client must not also
    // remove it — a partial disconnect does not change who owns that removal.
    expect(result).toEqual({
      hostEnvironmentIds: ['env-b'],
      closesLocally: false,
      removesVisibleTab: false
    })
  })

  it('tears down locally when no owning environment is connected', () => {
    expect(
      plan(
        [
          { id: 'page-1', environmentId: 'env-a' },
          { id: 'page-2', environmentId: 'env-b' }
        ],
        { activeEnvironmentIds: [] }
      )
    ).toEqual({ hostEnvironmentIds: [], closesLocally: true, removesVisibleTab: true })
  })

  it('keeps a local-fallback workspace local even while a runtime is focused', () => {
    expect(
      plan([{ id: 'page-1' }], {
        focusedEnvironmentId: 'env-a',
        activeEnvironmentIds: ['env-a']
      })
    ).toEqual({ hostEnvironmentIds: [], closesLocally: true, removesVisibleTab: true })
  })

  it('host-closes a pageless mirror of the focused runtime, which is otherwise un-closable', () => {
    expect(plan([], { focusedEnvironmentId: 'env-a', activeEnvironmentIds: ['env-a'] })).toEqual({
      hostEnvironmentIds: ['env-a'],
      closesLocally: false,
      removesVisibleTab: true
    })
  })

  // Why: a pageless mirror has no page to name an owner with, so the session layer resolves the
  // connected environment — as it did before this plan existed.
  it('still host-closes a pageless mirror whose environment the worktree cannot name', () => {
    expect(
      planBrowserWorkspaceTabClose({
        state: state([]),
        workspaceId: 'workspace-a',
        focusedEnvironmentId: null,
        isEnvironmentActive: () => true
      })
    ).toEqual({ hostEnvironmentIds: [null], closesLocally: false, removesVisibleTab: true })
  })
})

describe('getBrowserWorkspaceRemoteOwnership', () => {
  it('carries the owning environments on an ambiguous workspace', () => {
    const ownership = getBrowserWorkspaceRemoteOwnership(
      state([
        { id: 'page-1', environmentId: 'env-a' },
        { id: 'page-2', environmentId: 'env-b' }
      ]),
      'workspace-a'
    )

    expect(ownership.kind).toBe('ambiguous')
    expect(ownership.kind === 'ambiguous' && [...ownership.environmentIds].sort()).toEqual([
      'env-a',
      'env-b'
    ])
  })

  it('still reports a lone owner exactly and an unowned workspace as none', () => {
    expect(
      getBrowserWorkspaceRemoteOwnership(
        state([{ id: 'page-1', environmentId: 'env-a' }]),
        'workspace-a'
      )
    ).toEqual({ kind: 'exact', environmentId: 'env-a' })
    expect(getBrowserWorkspaceRemoteOwnership(state([{ id: 'page-1' }]), 'workspace-a')).toEqual({
      kind: 'none'
    })
  })
})
