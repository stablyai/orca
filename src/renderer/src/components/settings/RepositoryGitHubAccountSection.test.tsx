// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type {
  GhAccountBindingInventory,
  GhAuthAccount,
  GhMultiAccountCapability
} from '../../../../shared/github/auth-types'
import type { GhAccountBinding } from '../../../../shared/github/account-binding'
import type * as RepositoryGitHubAccountModule from './repository-github-account'
import { isGhAccountBindingEnforced } from './repository-github-account'
import { RepositoryGitHubAccountSection } from './RepositoryGitHubAccountSection'

const { listAccountsMock, validateBindingMock, storeState } = vi.hoisted(() => ({
  listAccountsMock: vi.fn(),
  validateBindingMock: vi.fn(),
  storeState: {
    settings: null,
    repos: [] as Repo[],
    settingsSearchQuery: ''
  }
}))

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

vi.mock('./repository-github-account', async (importOriginal) => ({
  ...(await importOriginal<typeof RepositoryGitHubAccountModule>()),
  listRepositoryGhBindableAccounts: listAccountsMock,
  validateRepositoryGhAccountBinding: validateBindingMock
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

const AMBIENT_VALUE = '__ambient_gh_login__'

const BASE_REPO: Repo = {
  id: 'repo-1',
  path: '/home/user/project',
  displayName: 'My Project',
  badgeColor: '#000000',
  addedAt: 0
}

const ALICE: GhAuthAccount = {
  host: 'github.com',
  user: 'alice',
  active: true,
  envToken: null,
  source: 'keyring',
  scopes: []
}

const ENV_BOT: GhAuthAccount = {
  host: 'github.com',
  user: 'bot',
  active: false,
  envToken: 'GH_TOKEN',
  source: 'env',
  scopes: []
}

function optionValue(binding: GhAccountBinding): string {
  return `${binding.host}\0${binding.user}`
}

function inventory(
  accounts: GhAuthAccount[],
  capability: GhMultiAccountCapability = 'supported'
): GhAccountBindingInventory {
  return { capability, accounts }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listAccountsMock.mockReset()
  validateBindingMock.mockReset()
  storeState.repos = []
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

type UpdateRepo = (repoId: string, updates: { ghAccount?: GhAccountBinding | null }) => unknown

/** updateRepo that echoes the binding back through the store, like a current-version host. */
function echoingUpdateRepo(): ReturnType<typeof vi.fn<UpdateRepo>> {
  return vi.fn<UpdateRepo>(async (repoId, updates) => {
    storeState.repos = storeState.repos.map((entry) =>
      entry.id === repoId ? { ...entry, ghAccount: updates.ghAccount ?? undefined } : entry
    )
    return true
  })
}

async function render(repo: Repo, updateRepo: UpdateRepo = echoingUpdateRepo()): Promise<void> {
  storeState.repos = [repo]
  await act(async () => {
    root.render(
      React.createElement(RepositoryGitHubAccountSection, {
        repo,
        updateRepo,
        forceVisible: true
      })
    )
  })
  // Flush the inventory load kicked off by the mount effect.
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

describe('RepositoryGitHubAccountSection', () => {
  it('offers keyring accounts, disables env-token accounts, and starts on the ambient option', async () => {
    listAccountsMock.mockResolvedValue(inventory([ALICE, ENV_BOT]))

    await render(BASE_REPO)

    expect(getSelect().value).toBe(AMBIENT_VALUE)
    expect(findOption('alice @ github.com').disabled).toBe(false)
    expect(findOption('bot @ github.com (GH_TOKEN)').disabled).toBe(true)
  })

  it('validates and then binds a keyring account', async () => {
    listAccountsMock.mockResolvedValue(inventory([ALICE]))
    validateBindingMock.mockResolvedValue({
      ok: true,
      binding: { host: 'github.com', user: 'alice' }
    })
    const updateRepo = echoingUpdateRepo()

    await render(BASE_REPO, updateRepo)
    await choose(optionValue(ALICE))

    expect(validateBindingMock).toHaveBeenCalledWith(expect.anything(), BASE_REPO, {
      host: 'github.com',
      user: 'alice'
    })
    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      ghAccount: { host: 'github.com', user: 'alice' }
    })
    expect(container.textContent).not.toContain('not enforced')
  })

  it('clears an existing binding through the ambient option without validating', async () => {
    listAccountsMock.mockResolvedValue(inventory([ALICE]))
    const updateRepo = echoingUpdateRepo()

    await render({ ...BASE_REPO, ghAccount: { host: 'github.com', user: 'alice' } }, updateRepo)
    expect(getSelect().value).toBe(optionValue(ALICE))

    await choose(AMBIENT_VALUE)

    expect(validateBindingMock).not.toHaveBeenCalled()
    expect(updateRepo).toHaveBeenCalledWith('repo-1', { ghAccount: null })
  })

  it('renders a disabled "(unavailable)" row for a bound account missing from the inventory', async () => {
    listAccountsMock.mockResolvedValue(inventory([ALICE]))
    const carol: GhAccountBinding = { host: 'github.com', user: 'carol' }

    await render({ ...BASE_REPO, ghAccount: carol })

    expect(getSelect().value).toBe(optionValue(carol))
    expect(findOption('carol @ github.com (unavailable)').disabled).toBe(true)
  })

  it('disables account rows but keeps the ambient option while capability is unsupported', async () => {
    listAccountsMock.mockResolvedValue(inventory([ALICE], 'unsupported'))

    await render({
      ...BASE_REPO,
      ghAccount: { host: 'github.com', user: 'alice' }
    })

    expect(findOption('alice @ github.com').disabled).toBe(true)
    expect(findOption('Default (ambient gh login)').disabled).toBe(false)
    expect(container.textContent).toContain('Binding is unavailable until')
  })

  it('flags a binding the host did not echo back as not enforced', async () => {
    listAccountsMock.mockResolvedValue(inventory([ALICE]))
    validateBindingMock.mockResolvedValue({
      ok: true,
      binding: { host: 'github.com', user: 'alice' }
    })

    await render(BASE_REPO, vi.fn<UpdateRepo>().mockResolvedValue(true))
    await choose(optionValue(ALICE))

    expect(container.textContent).toContain('Saved, but not enforced')
  })
})

describe('isGhAccountBindingEnforced', () => {
  it('is enforced when the host echoes the same binding', () => {
    expect(
      isGhAccountBindingEnforced(
        { host: 'github.com', user: 'Alice' },
        { host: 'github.com', user: 'Alice' }
      )
    ).toBe(true)
  })

  it('is not enforced when the host drops the binding', () => {
    expect(isGhAccountBindingEnforced({ host: 'github.com', user: 'Alice' }, undefined)).toBe(false)
    expect(isGhAccountBindingEnforced({ host: 'github.com', user: 'Alice' }, null)).toBe(false)
  })

  it('is not enforced when the host echoes a different account or host', () => {
    expect(
      isGhAccountBindingEnforced(
        { host: 'github.com', user: 'Alice' },
        { host: 'github.com', user: 'Bob' }
      )
    ).toBe(false)
    expect(
      isGhAccountBindingEnforced(
        { host: 'github.com', user: 'Alice' },
        { host: 'ghe.example.com', user: 'Alice' }
      )
    ).toBe(false)
  })

  it('treats a cleared binding as enforced only when nothing is echoed back', () => {
    expect(isGhAccountBindingEnforced(null, undefined)).toBe(true)
    expect(isGhAccountBindingEnforced(null, null)).toBe(true)
    expect(isGhAccountBindingEnforced(null, { host: 'github.com', user: 'Alice' })).toBe(false)
  })
})
