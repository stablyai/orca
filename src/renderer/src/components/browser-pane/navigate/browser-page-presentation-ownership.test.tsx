// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  annotateBrowserPageHandles,
  copyBrowserPageHandles
} from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import { installBrowserInitializationPresentationLifetime } from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'
import { adoptFrameDrawnClientHostedBrowserHandles } from '@/runtime/web-session-tabs-sync/frame-drawn-desktop-browser-handles'
import { buildLayoutFrameStorePatch } from '@/store/workspace-layout/frames/workspace-layout-frame-store-patch'
import { withHeldTabsAsDrawn } from '@/store/workspace-layout/frames/workspace-layout-frame-held-tabs'
import { installFrameOrderingHarness } from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-ordering-test-harness'
import {
  ENV,
  WT
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-fixtures'
import { publish, snapshot } from './browser-page-initialization-fixture'

installFrameOrderingHarness()
let stopLifetime = () => {}
let diagnostics: Parameters<
  NonNullable<typeof window.api.runtimeEnvironments.onSharedControlDiagnostics>
>[0]
const loss = () =>
  diagnostics({
    environmentId: ENV,
    transportGeneration: 1,
    diagnostics: {
      state: 'closed',
      pendingRequestCount: 0,
      subscriptionCount: 1,
      reconnectAttempt: 0,
      lastConnectedAt: 1,
      lastClose: null,
      lastError: null
    }
  })
const disposition = (id: string) =>
  useAppStore.getState().remoteBrowserPageHandlesByPageId[id]?.initializationPresentation
    ?.disposition
beforeEach(async () => {
  Object.assign(window.api.runtimeEnvironments, {
    onSharedControlDiagnostics: (callback: typeof diagnostics) => {
      diagnostics = callback
      return () => {}
    }
  })
  stopLifetime = installBrowserInitializationPresentationLifetime()
  await publish(snapshot('https://example.internal/S', 1))
})
afterEach(() => stopLifetime())

it('revokes the same live presentation after held-frame withdrawal, frame re-add and staged-handle adoption', () => {
  const original = useAppStore.getState()
  const handle = original.remoteBrowserPageHandlesByPageId['page-a']
  const empty = {
    ...original,
    browserTabsByWorktree: { [WT]: [] },
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {}
  }
  const held = withHeldTabsAsDrawn(empty, original, [WT], {
    isTabHeld: () => true,
    isGroupLayoutHeld: () => true
  })
  useAppStore.setState((state) => buildLayoutFrameStorePatch(state, held, [WT]))
  expect(disposition('page-a')).toBeUndefined()
  useAppStore.setState((state) => buildLayoutFrameStorePatch(state, original, [WT]))
  expect(useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']).toBe(handle)
  useAppStore.getState().setRemoteBrowserPageHandle('page-a', { ...handle, staged: true })
  useAppStore.setState((state) =>
    adoptFrameDrawnClientHostedBrowserHandles(
      state,
      snapshot('https://example.internal/S', 2),
      ENV,
      WT
    )
  )
  loss()
  expect(disposition('page-a')).toBe('unavailable')
})

it('folds both staged IDs across a copied record only when the agent-status batch commits', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.getState().removeRemoteBrowserPageHandle('page-a')
  useAppStore.getState().transactAgentStatuses(() => {
    useAppStore.getState().updateAgentStatusState((state) => ({
      remoteBrowserPageHandlesByPageId: Object.assign(
        copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['early']),
        { early: handle }
      )
    }))
    useAppStore.getState().updateAgentStatusState((state) => ({
      remoteBrowserPageHandlesByPageId: Object.assign(
        copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['late']),
        { late: handle }
      )
    }))
    expect(disposition('early')).toBeUndefined()
  })
  loss()
  expect(disposition('early')).toBe('unavailable')
  expect(disposition('late')).toBe('unavailable')
})

it('does no loss publication for an abandoned batch or a patch rejected by the editor invariant', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.getState().removeRemoteBrowserPageHandle('page-a')
  expect(() =>
    useAppStore.getState().transactAgentStatuses(() => {
      useAppStore.getState().updateAgentStatusState((state) => ({
        remoteBrowserPageHandlesByPageId: Object.assign(
          copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['abandoned']),
          { abandoned: handle }
        )
      }))
      throw new Error('abandoned')
    })
  ).toThrow('abandoned')
  useAppStore.setState({
    openFiles: ['edit-a', 'edit-b'].map((id) => ({
      id,
      filePath: '/tmp/shared.md',
      relativePath: 'shared.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      mode: 'edit' as const
    }))
  })
  expect(() =>
    useAppStore.setState((state) => ({
      remoteBrowserPageHandlesByPageId: Object.assign(
        copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['rejected']),
        { rejected: handle }
      ),
      editorDrafts: { 'edit-a': 'first', 'edit-b': 'second' }
    }))
  ).toThrow('differs from another view')
  let publications = 0
  const stop = useAppStore.subscribe(() => publications++)
  try {
    loss()
    expect(publications).toBe(0)
    expect(disposition('abandoned')).toBeUndefined()
    expect(disposition('rejected')).toBeUndefined()
  } finally {
    stop()
  }
})

it('accounts before reentrant loss and retains a committed write when its subscriber throws', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.getState().removeRemoteBrowserPageHandle('page-a')
  let notified = false
  const stop = useAppStore.subscribe(() => {
    if (notified) {
      return
    }
    notified = true
    loss()
    throw new Error('subscriber-after-commit')
  })
  try {
    expect(() => useAppStore.getState().setRemoteBrowserPageHandle('page-a', handle)).toThrow(
      'subscriber-after-commit'
    )
    expect(disposition('page-a')).toBe('unavailable')
    loss()
    expect(disposition('page-a')).toBe('unavailable')
  } finally {
    stop()
  }
})

it('rejects an unannotated record replacement before it can remove a live presentation', () => {
  const before = useAppStore.getState().remoteBrowserPageHandlesByPageId
  expect(() => useAppStore.setState({ remoteBrowserPageHandlesByPageId: {} })).toThrow(
    'missing changed page IDs'
  )
  expect(useAppStore.getState().remoteBrowserPageHandlesByPageId).toBe(before)
  loss()
  expect(disposition('page-a')).toBe('unavailable')
})

it('does no loss publication after closing the last handle, but revokes a remaining sibling', async () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore
    .getState()
    .setRemoteBrowserPageHandle('sibling', { ...handle, remotePageId: 'sibling' })
  useAppStore.getState().removeRemoteBrowserPageHandle('page-a')
  loss()
  expect(disposition('sibling')).toBe('unavailable')
  await publish(snapshot('https://example.internal/next', 2))
  useAppStore.getState().removeRemoteBrowserPageHandle('page-a')
  let publications = 0
  const stop = useAppStore.subscribe(() => publications++)
  try {
    loss()
    expect(publications).toBe(0)
  } finally {
    stop()
  }
})

it('keeps ownership through a valid whole-state replacement', () => {
  const state = useAppStore.getState()
  const handle = state.remoteBrowserPageHandlesByPageId['page-a']
  state.removeRemoteBrowserPageHandle('page-a')
  const current = useAppStore.getState()
  useAppStore.setState(
    {
      ...current,
      remoteBrowserPageHandlesByPageId: Object.assign(
        copyBrowserPageHandles(current.remoteBrowserPageHandlesByPageId, ['page-a']),
        { 'page-a': handle }
      )
    },
    true
  )
  loss()
  expect(disposition('page-a')).toBe('unavailable')
})

it('revokes a live sibling reinstalled by an outer updater after a nested accepted removal', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore
    .getState()
    .setRemoteBrowserPageHandle('sibling', { ...handle, remotePageId: 'sibling' })
  useAppStore.setState((state) => {
    const handles = copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['page-a'])
    delete handles['page-a']
    useAppStore.getState().removeRemoteBrowserPageHandle('sibling')
    return { remoteBrowserPageHandlesByPageId: handles }
  })
  expect(disposition('page-a')).toBeUndefined()
  expect(disposition('sibling')).toBe('pending')
  loss()
  expect(disposition('sibling')).toBe('unavailable')
})

it('does no loss publication for an inner addition omitted by the outer accepted record', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.setState((state) => {
    const handles = copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['page-a'])
    delete handles['page-a']
    useAppStore.getState().setRemoteBrowserPageHandle('sibling', handle)
    return { remoteBrowserPageHandlesByPageId: handles }
  })
  let publications = 0
  const stop = useAppStore.subscribe(() => publications++)
  try {
    loss()
    expect(disposition('page-a')).toBeUndefined()
    expect(disposition('sibling')).toBeUndefined()
    expect(publications).toBe(0)
  } finally {
    stop()
  }
})

it('carries an accepted descendant through a rejected updater and a partial intermediate write', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.getState().setRemoteBrowserPageHandle('sibling', handle)
  useAppStore.setState((state) => {
    const handles = copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['page-a'])
    delete handles['page-a']
    useAppStore.setState(() => {
      expect(() =>
        useAppStore.setState(() => {
          useAppStore.getState().removeRemoteBrowserPageHandle('sibling')
          throw new Error('rejected-ancestor')
        })
      ).toThrow('rejected-ancestor')
      return { activeBrowserTabId: null }
    })
    expect(disposition('sibling')).toBeUndefined()
    return { remoteBrowserPageHandlesByPageId: handles }
  })
  loss()
  expect(disposition('page-a')).toBeUndefined()
  expect(disposition('sibling')).toBe('unavailable')
})

it('still rejects an unannotated candidate after its nested write was accepted', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.getState().setRemoteBrowserPageHandle('sibling', handle)
  useAppStore.setState((state) => {
    const handles = copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['page-a'])
    delete handles['page-a']
    expect(() =>
      useAppStore.setState(() => {
        useAppStore.getState().removeRemoteBrowserPageHandle('sibling')
        return { remoteBrowserPageHandlesByPageId: {} }
      })
    ).toThrow('missing changed page IDs')
    expect(disposition('page-a')).toBe('pending')
    return { remoteBrowserPageHandlesByPageId: handles }
  })
  loss()
  expect(disposition('sibling')).toBe('unavailable')
})

it('carries a nested subscriber write to the evaluating outer updater', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  let notified = false
  const stop = useAppStore.subscribe(() => {
    if (!notified) {
      notified = true
      useAppStore.getState().setRemoteBrowserPageHandle('sibling', handle)
    }
  })
  try {
    useAppStore.setState((state) => {
      const handles = copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['page-a'])
      delete handles['page-a']
      useAppStore.getState().setRemoteBrowserPageHandle('page-a', { ...handle })
      return { remoteBrowserPageHandlesByPageId: handles }
    })
    let publications = 0
    const stopCount = useAppStore.subscribe(() => publications++)
    try {
      loss()
      expect(disposition('page-a')).toBeUndefined()
      expect(disposition('sibling')).toBeUndefined()
      expect(publications).toBe(0)
    } finally {
      stopCount()
    }
  } finally {
    stop()
  }
})

it('carries concrete IDs from real nested hydration without a later hot resync', () => {
  const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId['page-a']
  useAppStore.getState().setRemoteBrowserPageHandle('sibling', handle)
  useAppStore.setState((state) => {
    const handles = copyBrowserPageHandles(state.remoteBrowserPageHandlesByPageId, ['page-a'])
    delete handles['page-a']
    useAppStore.getState().hydrateBrowserSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })
    expect(disposition('sibling')).toBeUndefined()
    return { remoteBrowserPageHandlesByPageId: handles }
  })
  const next = copyBrowserPageHandles(useAppStore.getState().remoteBrowserPageHandlesByPageId, [
    'sibling'
  ])
  let enumerations = 0
  const counted = new Proxy(next, {
    ownKeys: (target) => {
      enumerations++
      return Reflect.ownKeys(target)
    }
  })
  useAppStore.setState({
    remoteBrowserPageHandlesByPageId: annotateBrowserPageHandles(counted, ['sibling'], next)
  })
  expect(enumerations).toBe(0)
  loss()
  expect(disposition('sibling')).toBe('unavailable')
})
