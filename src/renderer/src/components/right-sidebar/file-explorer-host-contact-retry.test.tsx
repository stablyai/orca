// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const contact = vi.hoisted(() => ({ listeners: new Map<string, () => void>() }))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    contact.listeners.set(environmentId, listener)
    return () => contact.listeners.delete(environmentId)
  }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: (_state: unknown, workspaceId: string | null) =>
    workspaceId === 'wt-host' ? 'wsl:ubuntu' : null
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: unknown) => T) =>
    selector({ settings: {}, sshConnectedGeneration: 0 })
}))
vi.mock('@/lib/workspace-switch-user-act', () => ({ takeRecentWorkspaceSwitchWake: () => false }))

import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

afterEach(() => {
  cleanup()
  contact.listeners.clear()
})

function render(workspaceKey: string, rootError: string | null) {
  const resetAndLoad = vi.fn()
  const hook = renderHook(
    ({ error }: { error: string | null }) =>
      useFileExplorerTreeLoadEffects({
        workspaceKey,
        visibleFilesWorktreePath: '/home/u/app',
        expanded: new Set(),
        dirCache: {},
        loadingDirPaths: new Set(),
        rootError: error,
        isDirStale: () => false,
        loadDir: vi.fn(async () => true),
        refreshTree: vi.fn(async () => undefined),
        resetAndLoad,
        resetSelection: vi.fn(),
        setNameFilterQuery: vi.fn()
      }),
    { initialProps: { error: rootError } }
  )
  resetAndLoad.mockClear()
  return { hook, resetAndLoad }
}

// QA F1: after a relaunch the tree loaded before the WSL host answered and showed its error until Retry.
it('reloads a tree that failed once its runtime host answers again', () => {
  const { resetAndLoad } = render('wt-host', 'The Orca server in the WSL distro isn’t answering')
  contact.listeners.get('wsl:ubuntu')?.()
  expect(resetAndLoad).toHaveBeenCalledOnce()
  // Without the user acting, so a stopped distro is never booted for it (E9).
  expect(resetAndLoad).toHaveBeenCalledWith()
})

it('leaves a tree that loaded fine alone, and a local workspace never subscribes', () => {
  const { hook, resetAndLoad } = render('wt-host', 'failed')
  hook.rerender({ error: null })
  contact.listeners.get('wsl:ubuntu')?.()
  expect(resetAndLoad).not.toHaveBeenCalled()

  cleanup()
  contact.listeners.clear()
  render('wt-local', 'failed')
  expect(contact.listeners.size).toBe(0)
})
