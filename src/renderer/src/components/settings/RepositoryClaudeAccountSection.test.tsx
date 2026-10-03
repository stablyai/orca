// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { RepoAgentAccounts } from '../../../../shared/claude/project-claude-account-preference'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { RepositoryClaudeAccountSection } from './RepositoryClaudeAccountSection'

const { fetchSnapshotMock, storeState } = vi.hoisted(() => {
  const repos: Repo[] = []
  return {
    fetchSnapshotMock: vi.fn(),
    storeState: {
      settings: null,
      repos,
      settingsSearchQuery: ''
    }
  }
})

vi.mock('../../store', () => {
  const useAppStore = (selector: (state: typeof storeState) => unknown) => selector(storeState)
  useAppStore.getState = () => storeState
  return { useAppStore }
})

vi.mock('@/lib/repo-runtime-owner', () => ({
  getRepoOwnerRoutedSettings: (settings: unknown) => settings
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: fetchSnapshotMock
}))

// Why: Radix Select needs pointer/layout APIs happy-dom lacks; a native select keeps value + disabled testable.
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

const DEFAULT_VALUE = '__default__'
const ASK_VALUE = '__ask__'

const BASE_REPO: Repo = {
  id: 'repo-1',
  path: '/home/user/project',
  displayName: 'My Project',
  badgeColor: '#000000',
  addedAt: 0
}

const ACCOUNT_A: ClaudeManagedAccountSummary = {
  id: 'account-a',
  email: 'a@x.com',
  authMethod: 'subscription-oauth',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
}

const ACCOUNT_B: ClaudeManagedAccountSummary = {
  id: 'account-b',
  email: 'b@y.com',
  authMethod: 'subscription-oauth',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
}

function snapshot(accounts: ClaudeManagedAccountSummary[]): ProviderAccountsSnapshot {
  return {
    claude: { accounts, activeAccountId: null, activeAccountIdsByRuntime: { host: null, wsl: {} } },
    codex: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits: null
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchSnapshotMock.mockReset()
  storeState.repos = []
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

type UpdateRepo = (repoId: string, updates: { agentAccounts?: RepoAgentAccounts | null }) => unknown

/** updateRepo that echoes the preference back through the store, like a current-version host. */
function echoingUpdateRepo(): ReturnType<typeof vi.fn<UpdateRepo>> {
  return vi.fn<UpdateRepo>(async (repoId, updates) => {
    storeState.repos = storeState.repos.map((entry) =>
      entry.id === repoId ? { ...entry, agentAccounts: updates.agentAccounts ?? undefined } : entry
    )
    return true
  })
}

async function render(repo: Repo, updateRepo: UpdateRepo = echoingUpdateRepo()): Promise<void> {
  storeState.repos = [repo]
  await act(async () => {
    root.render(
      React.createElement(RepositoryClaudeAccountSection, {
        repo,
        updateRepo,
        forceVisible: true
      })
    )
  })
  // Flush the account-snapshot load kicked off by the mount effect.
  await act(async () => {})
}

function getSelect(): HTMLSelectElement {
  const select = container.querySelector('select')
  if (!select) {
    throw new Error('account select not found')
  }
  return select
}

function findOption(text: string): HTMLOptionElement {
  const option = Array.from(container.querySelectorAll('option')).find((entry) =>
    entry.textContent?.includes(text)
  )
  if (!option) {
    throw new Error(`option containing "${text}" not found`)
  }
  return option
}

async function choose(value: string): Promise<void> {
  await act(async () => {
    const select = getSelect()
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('RepositoryClaudeAccountSection', () => {
  it('starts on Default and lists host accounts', async () => {
    fetchSnapshotMock.mockResolvedValue(snapshot([ACCOUNT_A, ACCOUNT_B]))

    await render(BASE_REPO)

    expect(getSelect().value).toBe(DEFAULT_VALUE)
    expect(findOption('Default')).toBeTruthy()
    expect(findOption('Ask every time')).toBeTruthy()
    expect(findOption('a@x.com')).toBeTruthy()
    expect(findOption('b@y.com')).toBeTruthy()
  })

  it('saves an account and clears back to Default', async () => {
    fetchSnapshotMock.mockResolvedValue(snapshot([ACCOUNT_A, ACCOUNT_B]))
    const updateRepo = echoingUpdateRepo()

    await render(BASE_REPO, updateRepo)
    await choose('account-a')

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      agentAccounts: { claude: { mode: 'account', accountId: 'account-a' } }
    })

    // The store echoed the save back; re-render with the updated repo like the real parent would.
    const afterSelect = storeState.repos.find((entry) => entry.id === 'repo-1')
    if (!afterSelect) {
      throw new Error('repo not found after select')
    }
    await act(async () => {
      root.render(
        React.createElement(RepositoryClaudeAccountSection, {
          repo: afterSelect,
          updateRepo,
          forceVisible: true
        })
      )
    })
    await choose(DEFAULT_VALUE)

    expect(updateRepo).toHaveBeenLastCalledWith('repo-1', { agentAccounts: null })
  })

  it('saves Ask every time', async () => {
    fetchSnapshotMock.mockResolvedValue(snapshot([ACCOUNT_A]))
    const updateRepo = echoingUpdateRepo()

    await render(BASE_REPO, updateRepo)
    await choose(ASK_VALUE)

    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      agentAccounts: { claude: { mode: 'ask' } }
    })
  })

  it('shows a removed saved account as unavailable', async () => {
    fetchSnapshotMock.mockResolvedValue(snapshot([ACCOUNT_A]))

    await render({
      ...BASE_REPO,
      agentAccounts: { claude: { mode: 'account', accountId: 'account-missing' } }
    })

    expect(getSelect().value).toBe('account-missing')
    const removed = findOption('(unavailable)')
    expect(removed.textContent).toBe('Removed account (unavailable)')
    expect(removed.disabled).toBe(true)
  })

  it('is disabled with a note for SSH projects', async () => {
    fetchSnapshotMock.mockResolvedValue(snapshot([ACCOUNT_A]))

    await render({ ...BASE_REPO, connectionId: 'ssh-1' })

    expect(getSelect().disabled).toBe(true)
    expect(fetchSnapshotMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain("aren't supported for this project's host yet")
  })
})
