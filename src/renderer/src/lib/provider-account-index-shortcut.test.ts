import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, toastMock, fetchSnapshotMock, selectClaudeMock, selectCodexMock } =
  vi.hoisted(() => {
    const toastErrorMock = vi.fn()
    const toast = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> }
    toast.error = toastErrorMock
    return {
      getStateMock: vi.fn(),
      toastMock: toast,
      toastErrorMock,
      fetchSnapshotMock: vi.fn(),
      selectClaudeMock: vi.fn(),
      selectCodexMock: vi.fn()
    }
  })

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('sonner', () => ({
  toast: toastMock
}))

vi.mock('../runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: fetchSnapshotMock,
  selectClaudeProviderAccount: selectClaudeMock,
  selectCodexProviderAccount: selectCodexMock
}))

import { switchProviderAccountByIndex } from './provider-account-index-shortcut'

function hostAccount(
  id: string,
  email: string
): {
  id: string
  email: string
  authMethod: 'subscription-oauth'
  managedAuthRuntime: 'host'
} {
  return { id, email, authMethod: 'subscription-oauth', managedAuthRuntime: 'host' }
}

describe('switchProviderAccountByIndex', () => {
  beforeEach(() => {
    getStateMock.mockReturnValue({ settings: {} })
    fetchSnapshotMock.mockReset()
    selectClaudeMock.mockReset()
    selectCodexMock.mockReset()
    toastMock.mockReset()
  })

  it('selects the Claude account at the given index and toasts its email', async () => {
    fetchSnapshotMock.mockResolvedValue({
      claude: {
        accounts: [hostAccount('a1', 'first@example.com'), hostAccount('a2', 'second@example.com')],
        activeAccountId: 'a1'
      },
      codex: { accounts: [], activeAccountId: null }
    })

    await switchProviderAccountByIndex('claude', 1)

    expect(selectClaudeMock).toHaveBeenCalledWith({}, { accountId: 'a2', runtime: 'host' })
    expect(toastMock).toHaveBeenCalledWith(
      'Switched to Claude account',
      expect.objectContaining({ description: 'second@example.com' })
    )
  })

  it('is a no-op when the index is already the active account', async () => {
    fetchSnapshotMock.mockResolvedValue({
      claude: {
        accounts: [hostAccount('a1', 'first@example.com')],
        activeAccountId: 'a1'
      },
      codex: { accounts: [], activeAccountId: null }
    })

    await switchProviderAccountByIndex('claude', 0)

    expect(selectClaudeMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('is a no-op when the index is out of range', async () => {
    fetchSnapshotMock.mockResolvedValue({
      claude: { accounts: [hostAccount('a1', 'first@example.com')], activeAccountId: 'a1' },
      codex: { accounts: [], activeAccountId: null }
    })

    await switchProviderAccountByIndex('claude', 5)

    expect(selectClaudeMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('excludes WSL accounts from the indexed list', async () => {
    fetchSnapshotMock.mockResolvedValue({
      claude: {
        accounts: [
          {
            id: 'w1',
            email: 'wsl@example.com',
            authMethod: 'subscription-oauth' as const,
            managedAuthRuntime: 'wsl' as const,
            wslDistro: 'Ubuntu'
          },
          hostAccount('a1', 'host@example.com')
        ],
        activeAccountId: 'w1'
      },
      codex: { accounts: [], activeAccountId: null }
    })

    await switchProviderAccountByIndex('claude', 0)

    expect(selectClaudeMock).toHaveBeenCalledWith({}, { accountId: 'a1', runtime: 'host' })
  })

  it('routes to selectCodexProviderAccount for the codex kind', async () => {
    fetchSnapshotMock.mockResolvedValue({
      claude: { accounts: [], activeAccountId: null },
      codex: {
        accounts: [hostAccount('c1', 'codex@example.com')],
        activeAccountId: null
      }
    })

    await switchProviderAccountByIndex('codex', 0)

    expect(selectCodexMock).toHaveBeenCalledWith({}, { accountId: 'c1', runtime: 'host' })
    expect(toastMock).toHaveBeenCalledWith(
      'Switched to Codex account',
      expect.objectContaining({ description: 'codex@example.com' })
    )
  })

  it('shows an error toast when the snapshot fetch fails', async () => {
    fetchSnapshotMock.mockRejectedValue(new Error('snapshot failed'))

    await switchProviderAccountByIndex('claude', 0)

    expect(toastMock.error).toHaveBeenCalledWith('Could not switch Claude account')
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('shows an error toast when the account switch fails', async () => {
    fetchSnapshotMock.mockResolvedValue({
      claude: {
        accounts: [hostAccount('a1', 'first@example.com')],
        activeAccountId: 'a2'
      },
      codex: { accounts: [], activeAccountId: null }
    })
    selectClaudeMock.mockRejectedValue(new Error('switch failed'))

    await switchProviderAccountByIndex('claude', 0)

    expect(toastMock.error).toHaveBeenCalledWith('Could not switch Claude account')
    expect(toastMock).not.toHaveBeenCalled()
  })
})
