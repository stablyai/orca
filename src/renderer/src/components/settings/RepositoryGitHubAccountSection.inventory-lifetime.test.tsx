// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { GhAccountBinding } from '../../../../shared/github/account-binding'
import type { GhAccountBindingInventory } from '../../../../shared/github/auth-types'
import type * as RepositoryGitHubAccountModule from './repository-github-account'
import { RepositoryGitHubAccountSection } from './RepositoryGitHubAccountSection'

const { listAccountsMock, validateBindingMock, storeState } = vi.hoisted(() => {
  const storeState: {
    settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
    repos: Repo[]
    settingsSearchQuery: string
  } = { settings: null, repos: [], settingsSearchQuery: '' }
  return { listAccountsMock: vi.fn(), validateBindingMock: vi.fn(), storeState }
})

vi.mock('../../store', () => {
  const useAppStore = (selector: (state: typeof storeState) => unknown) => selector(storeState)
  useAppStore.getState = () => storeState
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: (settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null) =>
    settings?.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' },
  callRuntimeRpc: vi.fn()
}))

vi.mock('./repository-github-account', async (importOriginal) => ({
  ...(await importOriginal<typeof RepositoryGitHubAccountModule>()),
  listRepositoryGhBindableAccounts: listAccountsMock,
  validateRepositoryGhAccountBinding: validateBindingMock
}))

// Radix requires layout APIs; the native select retains the account interaction.
vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    disabled,
    children
  }: {
    value: string
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  )
}))

const BASE_REPO: Repo = {
  id: 'repo-1',
  path: '/generated/project',
  displayName: 'Generated',
  badgeColor: '#000000',
  addedAt: 0,
  executionHostId: 'local'
}
const INVENTORY: GhAccountBindingInventory = {
  capability: 'supported',
  accounts: [
    {
      host: 'github.com',
      user: 'alice',
      active: true,
      envToken: null,
      source: 'keyring',
      scopes: []
    }
  ]
}
type UpdateRepo = (repoId: string, updates: { ghAccount?: GhAccountBinding | null }) => unknown
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listAccountsMock.mockReset().mockResolvedValue(INVENTORY)
  validateBindingMock.mockReset()
  storeState.settings = { activeRuntimeEnvironmentId: null }
  storeState.repos = []
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(repo: Repo, updateRepo: UpdateRepo = () => true): Promise<void> {
  storeState.repos = [repo]
  await act(async () =>
    root.render(<RepositoryGitHubAccountSection repo={repo} updateRepo={updateRepo} forceVisible />)
  )
}
function getSelect(): HTMLSelectElement {
  const select = container.querySelector('select')
  if (!select) {
    throw new Error('account select missing')
  }
  return select
}
function getRefreshButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Refresh GitHub accounts"]'
  )
  if (!button) {
    throw new Error('refresh button missing')
  }
  return button
}

describe('repository account inventory request ownership', () => {
  it('keeps the loaded selector through five committed display-name changes', async () => {
    await render(BASE_REPO)
    for (const displayName of [
      'Generated A',
      'Generated AB',
      'Generated ABC',
      'Generated ABCD',
      'Generated ABCDE'
    ]) {
      await render({ ...BASE_REPO, displayName })
      expect(getSelect().disabled).toBe(false)
    }
    expect(listAccountsMock).toHaveBeenCalledTimes(1)
  })

  const scopeChanges: { name: string; initial?: Partial<Repo>; updates: Partial<Repo> }[] = [
    { name: 'repo id', updates: { id: 'repo-2' } },
    { name: 'repo path', updates: { path: '/generated/other' } },
    { name: 'execution owner', updates: { executionHostId: 'runtime:server-1' } },
    { name: 'SSH connection owner', updates: { connectionId: 'ssh-2' } },
    {
      name: 'canonical remote identity',
      updates: {
        gitRemoteIdentity: {
          canonicalKey: 'ghe.example.com/team/project',
          remoteName: 'origin',
          remoteUrl: 'https://ghe.example.com/team/project'
        }
      }
    },
    {
      name: 'bound account host',
      initial: { ghAccount: { host: 'github.com', user: 'alice' } },
      updates: { ghAccount: { host: 'ghe.example.com', user: 'alice' } }
    },
    {
      name: 'bound account user',
      initial: { ghAccount: { host: 'github.com', user: 'alice' } },
      updates: { ghAccount: { host: 'github.com', user: 'bob' } }
    }
  ]
  it.each(scopeChanges)('refreshes after changing $name', async ({ initial, updates }) => {
    const repo = { ...BASE_REPO, ...initial }
    await render(repo)
    await render({ ...repo, ...updates })
    expect(listAccountsMock).toHaveBeenCalledTimes(2)
  })

  it('reloads for a changed legacy runtime target and keeps explicit refresh forced', async () => {
    const repo: Repo = { ...BASE_REPO, executionHostId: undefined }
    storeState.settings = { activeRuntimeEnvironmentId: 'server-1' }
    await render(repo)
    storeState.settings = { activeRuntimeEnvironmentId: 'server-2' }
    await render(repo)
    expect(listAccountsMock).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'server-2' },
      { id: repo.id, path: repo.path },
      { refreshCapability: false }
    )
    await act(async () => getRefreshButton().click())
    expect(listAccountsMock).toHaveBeenNthCalledWith(
      3,
      { kind: 'environment', environmentId: 'server-2' },
      { id: repo.id, path: repo.path },
      { refreshCapability: true }
    )
  })

  it('ignores an earlier scope reply while the current scope still owns loading', async () => {
    const oldRequest = Promise.withResolvers<GhAccountBindingInventory>()
    const currentRequest = Promise.withResolvers<GhAccountBindingInventory>()
    listAccountsMock
      .mockReset()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    await render(BASE_REPO)
    await render({ ...BASE_REPO, path: '/generated/other' })
    await act(async () => oldRequest.resolve(INVENTORY))
    expect(getSelect().disabled).toBe(true)
    expect(container.textContent).not.toContain('alice @ github.com')
    await act(async () =>
      currentRequest.resolve({
        ...INVENTORY,
        accounts: INVENTORY.accounts.map((account) => ({ ...account, user: 'bob' }))
      })
    )
    expect(getSelect().disabled).toBe(false)
    expect(container.textContent).toContain('bob @ github.com')
  })

  it('uses the latest repo in binding callbacks after unrelated edits', async () => {
    const updateRepo = vi.fn<UpdateRepo>().mockResolvedValue(true)
    validateBindingMock.mockResolvedValue({
      ok: true,
      binding: { host: 'github.com', user: 'alice' }
    })
    await render(BASE_REPO, updateRepo)
    const editedRepo = { ...BASE_REPO, displayName: 'Generated edited' }
    await render(editedRepo, updateRepo)
    await act(async () => {
      const select = getSelect()
      select.value = 'github.com\0alice'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(validateBindingMock).toHaveBeenCalledWith({ kind: 'local' }, editedRepo, {
      host: 'github.com',
      user: 'alice'
    })
    expect(updateRepo).toHaveBeenCalledWith(editedRepo.id, {
      ghAccount: { host: 'github.com', user: 'alice' }
    })
    expect(listAccountsMock).toHaveBeenCalledTimes(1)
  })
})
