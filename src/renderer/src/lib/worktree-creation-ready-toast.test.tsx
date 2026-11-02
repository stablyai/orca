import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { Repo } from '../../../shared/repo-types'

type ReadyToast = {
  id: number
  title: string
  duration?: number
  label: ReactNode
  onClick: () => void
  onDismiss: () => void
  onAutoClose: () => void
}

const { toasts, store } = await vi.hoisted(async () => {
  const { createStore } = await import('zustand/vanilla')
  const toasts: ReadyToast[] = []
  const store = createStore<{
    repos: Pick<Repo, 'id' | 'kind'>[]
    activeView: 'terminal' | 'tasks'
    activeWorktreeId: string | null
    activePendingCreationId: string | null
    activeWorkspaceExecutionHostId: ExecutionHostId | null
    worktreesByRepo: Record<string, Pick<Worktree, 'id' | 'repoId' | 'hostId'>[]>
    settings: { activeRuntimeEnvironmentId: string | null }
  }>(() => ({
    repos: [],
    activeView: 'terminal',
    activeWorktreeId: null,
    activePendingCreationId: null,
    activeWorkspaceExecutionHostId: null,
    worktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: null }
  }))
  return { toasts, store }
})

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    success: (
      title: string,
      options: {
        duration?: number
        action: { label: ReactNode; onClick: () => void }
        onDismiss: () => void
        onAutoClose: () => void
      }
    ) => {
      const id = toasts.length + 1
      toasts.push({
        id,
        title,
        duration: options.duration,
        ...options.action,
        onDismiss: options.onDismiss,
        onAutoClose: options.onAutoClose
      })
      return id
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: store
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn()
}))

import { toast } from 'sonner'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { showWorktreeCreationReadyToast } from './worktree-creation-ready-toast'

const worktree = {
  id: 'repo-1::/workspace/feature',
  repoId: 'repo-1',
  displayName: 'Feature',
  branch: 'refs/heads/feature',
  path: '/workspace/feature'
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const entry of toasts) {
    entry.onDismiss()
  }
  toasts.length = 0
  store.setState({
    repos: [],
    activeView: 'terminal',
    activeWorktreeId: null,
    activePendingCreationId: null,
    activeWorkspaceExecutionHostId: null,
    worktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: null }
  })
})

describe('showWorktreeCreationReadyToast', () => {
  it('names a git worktree and offers to go to it', () => {
    store.setState({ repos: [{ id: 'repo-1', kind: 'git' }] })

    showWorktreeCreationReadyToast(worktree)

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toBe('Worktree Feature is ready')
    expect(toasts[0]?.duration).toBe(Infinity)
    const label = renderToStaticMarkup(<>{toasts[0]?.label}</>)
    expect(label).toContain('lucide-external-link')
    expect(label).toContain('Go to worktree')

    toasts[0]?.onClick()
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith(worktree.id, {
      sidebarRevealBehavior: 'auto',
      navigationIntent: 'user-open'
    })
  })

  it('calls a folder repo workspace a workspace, not a worktree', () => {
    store.setState({ repos: [{ id: 'repo-1', kind: 'folder' }] })

    showWorktreeCreationReadyToast(worktree)

    expect(toasts[0]?.title).toBe('Workspace Feature is ready')
    const label = renderToStaticMarkup(<>{toasts[0]?.label}</>)
    expect(label).toContain('lucide-external-link')
    expect(label).toContain('Go to workspace')
    expect(label).not.toContain('Go to worktree')
  })

  it('keeps the worktree wording when the repo is unknown', () => {
    store.setState({ repos: [] })

    showWorktreeCreationReadyToast(worktree)

    expect(toasts[0]?.title).toBe('Worktree Feature is ready')
    expect(renderToStaticMarkup(<>{toasts[0]?.label}</>)).toContain('Go to worktree')
  })

  it('dismisses only the opened worktree notification and releases its subscription', async () => {
    showWorktreeCreationReadyToast(worktree)
    showWorktreeCreationReadyToast({ ...worktree, id: 'repo-1::/workspace/other' })

    store.setState({ activeWorktreeId: 'repo-1::/workspace/unrelated' })
    expect(toast.dismiss).not.toHaveBeenCalled()
    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)

    store.setState({ activeWorktreeId: null })
    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledTimes(1)
    store.setState({ activeWorktreeId: 'repo-1::/workspace/other' })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenLastCalledWith(toasts[1]?.id)
  })

  it('waits until the worktree is shown instead of another view or creation panel', async () => {
    store.setState({ activeView: 'tasks', activeWorktreeId: worktree.id })
    showWorktreeCreationReadyToast(worktree)
    store.setState({ activeView: 'terminal', activePendingCreationId: 'creation-2' })
    expect(toast.dismiss).not.toHaveBeenCalled()

    store.setState({ activePendingCreationId: null })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('does not show a late notification for a worktree already being viewed', () => {
    store.setState({ activeWorktreeId: worktree.id })
    showWorktreeCreationReadyToast(worktree)
    expect(toasts).toHaveLength(0)
  })

  it('also dismisses when a folder workspace is opened', async () => {
    store.setState({ repos: [{ id: 'repo-1', kind: 'folder' }] })
    showWorktreeCreationReadyToast(worktree)
    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('matches equivalent remote workspace paths', async () => {
    const remote = { ...worktree, id: 'ssh-repo::C:\\workspace\\feature' }
    showWorktreeCreationReadyToast(remote)
    store.setState({ activeWorktreeId: 'ssh-repo::c:/workspace/feature' })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it.each(['onDismiss', 'onAutoClose', 'onClick'] as const)(
    'releases the navigation subscription on %s',
    (callback) => {
      showWorktreeCreationReadyToast(worktree)
      toasts[0]?.[callback]()
      store.setState({ activeWorktreeId: worktree.id })
      expect(toast.dismiss).not.toHaveBeenCalled()
    }
  )

  it('keeps a remote notification until that host is opened, even when IDs collide', async () => {
    const remote = { ...worktree, hostId: 'runtime:remote-a' as const }
    store.setState({ activeWorktreeId: worktree.id, activeWorkspaceExecutionHostId: 'local' })
    showWorktreeCreationReadyToast(remote)
    expect(toasts).toHaveLength(1)
    store.setState({ activeWorktreeId: null })
    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).not.toHaveBeenCalled()
    store.setState({ activeWorkspaceExecutionHostId: remote.hostId })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('resolves the selected host from the catalog when selection is unqualified', async () => {
    const local = { ...worktree, hostId: 'local' as const }
    store.setState({ worktreesByRepo: { [worktree.repoId]: [local] } })
    showWorktreeCreationReadyToast(local)
    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('routes an unqualified selection by the owner row, not the Active Server setting', async () => {
    store.setState({
      repos: [{ id: 'repo-1', kind: 'git' }],
      worktreesByRepo: { [worktree.repoId]: [{ id: worktree.id, repoId: worktree.repoId }] },
      settings: { activeRuntimeEnvironmentId: 'remote-a' }
    })
    showWorktreeCreationReadyToast(worktree, 'local')
    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('opens the notification target on its captured host', () => {
    showWorktreeCreationReadyToast({ ...worktree, hostId: 'runtime:remote-a' })
    toasts[0]?.onClick()
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith(worktree.id, {
      sidebarRevealBehavior: 'auto',
      navigationIntent: 'user-open',
      executionHostId: 'runtime:remote-a'
    })
  })

  it('keeps the notification when navigation passes through its remembered workspace', async () => {
    store.setState({ activeView: 'tasks', activeWorktreeId: worktree.id })
    showWorktreeCreationReadyToast(worktree)
    store.setState({ activeView: 'terminal' })
    store.setState({ activeWorktreeId: 'repo-1::/workspace/unrelated' })
    await Promise.resolve()
    expect(toast.dismiss).not.toHaveBeenCalled()

    store.setState({ activeWorktreeId: worktree.id })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('cancels a queued dismissal when the notification is closed manually', async () => {
    showWorktreeCreationReadyToast(worktree)
    store.setState({ activeWorktreeId: worktree.id })
    toasts[0]?.onDismiss()
    await Promise.resolve()
    expect(toast.dismiss).not.toHaveBeenCalled()
  })

  it.each([undefined, 'runtime:remote-a'] as const)(
    'projects a paired response into the renderer host with creation host %s',
    async (creationHostId) => {
      const raw = { ...worktree, hostId: 'local' as const }
      store.setState({
        worktreesByRepo: { [worktree.repoId]: [{ ...worktree, hostId: 'runtime:remote-a' }] }
      })
      showWorktreeCreationReadyToast(raw, creationHostId)
      store.setState({ activeWorktreeId: worktree.id, activeWorkspaceExecutionHostId: 'local' })
      await Promise.resolve()
      expect(toast.dismiss).not.toHaveBeenCalled()
      toasts[0]?.onClick()
      expect(activateAndRevealWorkspace).toHaveBeenCalledWith(worktree.id, {
        sidebarRevealBehavior: 'auto',
        navigationIntent: 'user-open',
        executionHostId: 'runtime:remote-a'
      })
      store.setState({ activeWorktreeId: null })
      showWorktreeCreationReadyToast(raw, creationHostId)
      store.setState({
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'runtime:remote-a'
      })
      await Promise.resolve()
      expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[1]?.id)
    }
  )

  it('preserves nested SSH ownership reached through a paired runtime', async () => {
    showWorktreeCreationReadyToast({ ...worktree, hostId: 'ssh:remote-a' }, 'runtime:hub')
    store.setState({ activeWorktreeId: worktree.id, activeWorkspaceExecutionHostId: 'runtime:hub' })
    await Promise.resolve()
    expect(toast.dismiss).not.toHaveBeenCalled()
    store.setState({ activeWorkspaceExecutionHostId: 'ssh:remote-a' })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[0]?.id)
  })

  it('keeps an unqualified notification when the catalog cannot prove its host', async () => {
    store.setState({
      worktreesByRepo: {
        [worktree.repoId]: [
          { ...worktree, hostId: 'local' },
          { ...worktree, hostId: 'runtime:remote-a' }
        ]
      }
    })
    showWorktreeCreationReadyToast(worktree)
    store.setState({ activeWorktreeId: worktree.id, activeWorkspaceExecutionHostId: 'local' })
    await Promise.resolve()
    expect(toast.dismiss).not.toHaveBeenCalled()
  })

  it('keeps captured local ownership for legacy rows without a host', async () => {
    showWorktreeCreationReadyToast(worktree, 'local')
    store.setState({
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'runtime:remote-a'
    })
    await Promise.resolve()
    expect(toast.dismiss).not.toHaveBeenCalled()
    toasts[0]?.onClick()
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith(worktree.id, {
      sidebarRevealBehavior: 'auto',
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
    store.setState({ activeWorktreeId: null })
    showWorktreeCreationReadyToast(worktree, 'local')
    store.setState({ activeWorktreeId: worktree.id, activeWorkspaceExecutionHostId: 'local' })
    await Promise.resolve()
    expect(toast.dismiss).toHaveBeenCalledExactlyOnceWith(toasts[1]?.id)
  })
})
