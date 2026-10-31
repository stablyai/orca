// @vitest-environment happy-dom
import { nestedRemovalCatalog } from './settings-project-continuity-test-fixtures'
import * as removalProduct from './repository/RepositoryRemoveProjectButton'
import { removeCurrentSettingsProject } from './use-settings-store-model'
import { makeWorktree, makeOpenFile, makeTab } from '@/store/slices/store-test-helpers'
import { toast } from 'sonner'
import {
  openProjectRemovalSettings,
  RepoHeaderProjectActionsMenu
} from '../sidebar/worktree-list/rows/repo-header-project-actions'
import { getKnownRepoWorktreeIds } from '@/store/repos/repo-removal-workspaces'
import {
  RepositoryRemoveProjectButton,
  useSettingsProjectRemovalDescription
} from './repository/RepositoryRemoveProjectButton'
import { act } from 'react'
import { render, cleanup, screen, renderHook } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import { getSettingsProjectHostRepo } from './settings-project-list'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each(['host', 'folder', 'repository'] as const)(
  'joins authored nested registrations to current %s Settings disclosure without borrowing the raw-ID winner',
  (mode) => {
    const { repos, x, y, entries } = nestedRemovalCatalog(mode)
    expect(getSettingsProjectHostRepo(x, repos, 'runtime:E')?.connectionId).toBe('x')
    const selection = renderHook(() =>
      useSettingsProjectRemovalDescription(
        repos[0],
        mode === 'folder' ? 'checkout' : mode === 'host' ? 'host:runtime:E' : 'project',
        x.selectionKey,
        x.setups
      )
    )
    const description = selection.result.current.description
    expect(description).toContain('E · Build X: /srv/r')
    expect(description).toContain('E · Build Y: /srv/r')
    expect(description).not.toContain('WRONG LOCAL')
    expect(description.includes('/srv/q')).toBe(mode === 'repository')
    const xProduct = removalProduct.prepareSettingsProjectRemoval(
      useAppStore.getState(),
      repos[0],
      'project',
      x.selectionKey,
      x.setups
    )
    expect(xProduct.addresses.map((setup) => setup.repoId)).toEqual(
      mode === 'repository' ? ['r', 'q'] : ['r']
    )
    if (y) {
      const yProduct = removalProduct.prepareSettingsProjectRemoval(
        useAppStore.getState(),
        repos[1],
        'project',
        y.selectionKey,
        y.setups
      )
      expect(yProduct.description).toContain('Build X: /srv/r')
      expect(yProduct.description).toContain('Build Y: /srv/r')
      expect(yProduct.addresses.map((setup) => setup.repoId)).toEqual(
        mode === 'host' ? ['r', 'q'] : ['r']
      )
      expect(yProduct.description.includes('/srv/q')).toBe(mode === 'host')
    }
    expect(entries.flatMap((entry) => entry.setups)).toHaveLength(3)
    selection.unmount()
  }
)

it('routes the real nested header Remove to its actual H without arming or deleting, including a Y host copy', async () => {
  const { repos, x, y } = nestedRemovalCatalog()
  const remove = vi.spyOn(useAppStore.getState(), 'removeProject')
  const scope = {
    key: y!.selectionKey,
    registrations: y!.setups,
    catalogHostId: 'runtime:E' as const
  }
  render(
    <TooltipProvider>
      <RepoHeaderProjectActionsMenu
        repo={repos[1]}
        contextRepo={repos[1]}
        projectScope={scope}
        label="Harbor Y"
        projectGroups={[]}
        actions={{
          getWorktreeVisibilityDefaults: () => undefined,
          onOpenRepoSettings: () => {},
          onOpenWorktreeVisibility: () => {},
          onCreateGroupFromRepo: () => {},
          onMoveProjectToGroup: () => {},
          onRemoveProjectFromGroup: () => {},
          onCreateForRepo: () => {},
          onRemoveProject: openProjectRemovalSettings
        }}
      />
    </TooltipProvider>
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Project actions for Harbor Y' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Remove Project' }))
  expect(useAppStore.getState().settingsNavigationTarget).toEqual({
    pane: 'repo',
    repoId: 'r',
    hostId: 'runtime:E',
    sectionId: `repo-${y!.selectionKey}`
  })
  expect(useAppStore.getState().settingsNavigationTarget?.sectionId).not.toBe(
    `repo-${x.selectionKey}`
  )
  expect(useAppStore.getState().activeView).toBe('settings')
  expect(remove).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Confirm Remove Project' })).toBeNull()
  remove.mockRestore()
})

it('uses the expanded current nested dirty/terminal/VM product while preserving shared buffers and lower purge authority', async () => {
  const { repos, x } = nestedRemovalCatalog()
  const wx = makeWorktree({
    id: 'r::/srv/r/x',
    repoId: 'r',
    hostId: 'ssh:x',
    runtimeOwnerEnvironmentId: 'E'
  })
  const wy = makeWorktree({
    id: 'r::/srv/r/y',
    repoId: 'r',
    hostId: 'ssh:y',
    runtimeOwnerEnvironmentId: 'E',
    ephemeralVmCheckoutMode: 'provisioned-root'
  })
  const foreign = makeWorktree({
    id: 'r::/other',
    repoId: 'r',
    hostId: 'ssh:y',
    runtimeOwnerEnvironmentId: 'OTHER'
  })
  const dirty = makeOpenFile({
    id: 'dirty-y',
    filePath: '/srv/shared.ts',
    worktreeId: wy.id,
    isDirty: true,
    runtimeEnvironmentId: 'E'
  })
  const unrelated = makeOpenFile({
    id: 'dirty-other',
    worktreeId: foreign.id,
    isDirty: true,
    runtimeEnvironmentId: 'OTHER'
  })
  useAppStore.setState({
    worktreesByRepo: { r: [wx, foreign] },
    detectedWorktreesByRepo: {
      r: {
        repoId: 'r',
        authoritative: true,
        source: 'git',
        worktrees: [{ ...wy, ownership: 'orca-managed', visible: true, selectedCheckout: false }]
      }
    },
    openFiles: [dirty, unrelated],
    tabsByWorktree: {
      [wy.id]: [makeTab({ id: 'term-y', worktreeId: wy.id })],
      [foreign.id]: [makeTab({ id: 'term-other', worktreeId: foreign.id })]
    },
    ptyIdsByTabId: { 'term-y': ['test-pty'], 'term-other': ['other-pty'] }
  })
  const product = removalProduct.prepareSettingsProjectRemoval(
    useAppStore.getState(),
    repos[0],
    'host:runtime:E',
    x.selectionKey,
    x.setups
  )
  expect(product.targets).toEqual([
    { id: wx.id, hostId: 'ssh:x' },
    { id: wy.id, hostId: 'ssh:y' }
  ])
  expect([...product.closedFileIds]).toEqual([dirty.id])
  expect(product.description).toContain('1 open terminal in this project will be closed')
  expect(product.description).toContain('VM recipe determines')
  expect(product.description).not.toContain('It is still on your disk')
  // This operation-only correction must not broaden the old post-success helper.
  expect(getKnownRepoWorktreeIds(useAppStore.getState(), 'r', 'runtime:E')).toEqual([])
  const originalRemove = useAppStore.getState().removeProject
  const dispatch = vi.fn(async () => {})
  const error = vi.spyOn(toast, 'error')
  useAppStore.setState({ removeProject: dispatch })
  await removeCurrentSettingsProject(x.setups, product)
  expect(dispatch).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledWith('Save or close 1 unsaved file in Harbor X first')
  const sibling = makeOpenFile({
    ...dirty,
    id: 'shared-survivor',
    isDirty: false,
    worktreeId: 'q::/srv/q',
    runtimeEnvironmentId: 'E'
  })
  useAppStore.setState({
    worktreesByRepo: {
      ...useAppStore.getState().worktreesByRepo,
      q: [
        makeWorktree({
          id: sibling.worktreeId,
          repoId: 'q',
          hostId: 'ssh:y',
          runtimeOwnerEnvironmentId: 'E'
        })
      ]
    },
    openFiles: [dirty, sibling, unrelated]
  })
  expect(useAppStore.getState().editorBufferIdOf[dirty.id]).toBe(
    useAppStore.getState().editorBufferIdOf[sibling.id]
  )
  const shared = removalProduct.prepareSettingsProjectRemoval(
    useAppStore.getState(),
    repos[0],
    'host:runtime:E',
    x.selectionKey,
    x.setups
  )
  await removeCurrentSettingsProject(x.setups, shared)
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('r', {
    hostId: 'runtime:E',
    errorFeedback: 'toast'
  })
  useAppStore.setState({ removeProject: originalRemove })
  error.mockRestore()
})

it('compares the current address disclosure synchronously before accepting and keeps rank/equal/focus publications armed', async () => {
  const { repos, x } = nestedRemovalCatalog()
  const dispatch = vi.fn()
  let displayed = removalProduct.prepareSettingsProjectRemoval(
    useAppStore.getState(),
    repos[0],
    'host:runtime:E',
    x.selectionKey,
    x.setups
  )
  const read = () =>
    removalProduct.prepareSettingsProjectRemoval(
      useAppStore.getState(),
      repos[0],
      'host:runtime:E',
      x.selectionKey,
      x.setups
    )
  const view = render(
    <TooltipProvider>
      <RepositoryRemoveProjectButton
        repo={repos[0]}
        description={displayed.description}
        confirmationKey={displayed.signature}
        readCurrentRemoval={read}
        forceVisible
        removeProject={(id, accepted) => {
          expect(accepted).toEqual(read())
          dispatch(id)
        }}
      />
    </TooltipProvider>
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Remove Project' }))
  act(() =>
    useAppStore.setState({
      repos: [{ ...repos[0], projectGroupOrder: 99 }, { ...repos[1] }, repos[2]],
      settings: { ...useAppStore.getState().settings!, activeRuntimeEnvironmentId: 'OTHER' }
    })
  )
  expect(read().signature).toBe(displayed.signature)
  // No subscribed render/cleanup is allowed to rescue this stale click.
  act(() =>
    useAppStore.setState({ repos: [repos[0], { ...repos[1], path: '/srv/changed-y' }, repos[2]] })
  )
  await user.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
  expect(dispatch).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Confirm Remove Project' })).toBeNull()
  displayed = read()
  view.rerender(
    <TooltipProvider>
      <RepositoryRemoveProjectButton
        repo={repos[0]}
        description={displayed.description}
        confirmationKey={displayed.signature}
        readCurrentRemoval={read}
        forceVisible
        removeProject={(id, accepted) => {
          expect(accepted).toEqual(read())
          dispatch(id)
        }}
      />
    </TooltipProvider>
  )
  await user.click(screen.getByRole('button', { name: 'Remove Project' }))
  await user.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
  expect(dispatch).toHaveBeenCalledExactlyOnceWith('r')
})
