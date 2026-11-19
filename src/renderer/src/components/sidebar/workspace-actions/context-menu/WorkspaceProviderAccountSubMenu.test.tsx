// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { WorkspaceAccountAssignment } from '../../../../../../shared/agent-accounts/workspace-account-binding'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { notifyWorkspaceAccountSettingsChanged } from '@/runtime/provider-accounts/observations/workspace-account-settings-changes'
import { WorkspaceProviderAccountSubMenu } from './WorkspaceProviderAccountSubMenu'
import { makeWorktree } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'

const state = vi.hoisted(
  (): {
    settings: ReturnType<typeof getDefaultSettings> | null
    accounts: CodexRateLimitAccountsState | null
    assignments: WorkspaceAccountAssignment[]
  } => ({ settings: null, accounts: null, assignments: [] })
)
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign((selector: (value: unknown) => unknown) => selector(state), {
    getState: () => ({ fetchSettings: async () => {} })
  })
}))
vi.mock('@/i18n/use-translate', () => ({ useTranslate: () => translate }))
vi.mock('@/runtime/rpc/targets/use-worktree-runtime-target', () => ({
  useWorktreeRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/runtime/hosts/preflight/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/runtime/provider-accounts/ownership/wsl-host-account-owner', () => ({
  wslHostDistroForTarget: () => null
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (
    _owner: unknown,
    method: string,
    params?: { codexWorkspaceAccount?: WorkspaceAccountAssignment }
  ) => {
    if (method === 'settings.update' && params?.codexWorkspaceAccount) {
      state.assignments.push(params.codexWorkspaceAccount)
    }
    return { settings: state.settings, codex: { accounts: [], activeAccountId: null } }
  }
}))
const translate = (_key: string, fallback: string) => fallback
const worktree = makeWorktree('folder:client', 'Client', { path: '/client' })
const account = (id: string) => ({
  id,
  email: `${id}@example.com`,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
})

beforeEach(() => {
  state.settings = getDefaultSettings('/viewer')
  state.settings.codexWorkspaceAccounts = {}
  state.accounts = { accounts: [account('personal')], activeAccountId: null }
  state.assignments = []
  window.api = {
    ...window.api,
    codexAccounts: { ...window.api?.codexAccounts, list: async () => state.accounts! },
    claudeAccounts: {
      ...window.api?.claudeAccounts,
      list: async () => ({ accounts: [], activeAccountId: null })
    }
  }
})
afterEach(cleanup)

it('offers the desktop roster and updates selectable accounts after an account settings change', async () => {
  renderMenu()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'personal@example.com' }))
  await act(async () => {})
  expect(state.assignments).toContainEqual({ workspaceId: 'folder:client', accountId: 'personal' })
  state.accounts = { accounts: [account('business')], activeAccountId: null }
  await act(async () => {
    notifyWorkspaceAccountSettingsChanged({ kind: 'local' })
  })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'business@example.com' }))
  await act(async () => {})
  expect(state.assignments).toContainEqual({ workspaceId: 'folder:client', accountId: 'business' })
})

it('can choose the real system default and restore inheritance by selecting the host account', async () => {
  state.accounts = {
    accounts: [account('personal')],
    activeAccountId: 'personal',
    systemDefault: {
      hasAuth: true,
      authKind: 'oauth',
      email: 'system@example.com',
      providerAccountId: 'system-login',
      workspaceLabel: 'Personal (Plus)'
    }
  }
  renderMenu()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: /system@example.com/ }))
  await act(async () => {})
  expect(state.assignments).toContainEqual({
    workspaceId: 'folder:client',
    accountId: 'system-default'
  })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: /personal@example.com/ }))
  await act(async () => {})
  expect(state.assignments).toContainEqual({ workspaceId: 'folder:client', accountId: null })
})

function renderMenu() {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger>Accounts</DropdownMenuTrigger>
      <DropdownMenuContent>
        <WorkspaceProviderAccountSubMenu
          provider="codex"
          worktree={worktree}
          disabled={false}
          asSection
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

it('inherits the host system default when the legacy selection names a WSL account', async () => {
  state.accounts = {
    accounts: [
      account('personal'),
      { ...account('wsl-user'), managedHomeRuntime: 'wsl', wslDistro: 'Ubuntu' }
    ],
    activeAccountId: 'wsl-user',
    activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-user' } }
  }
  renderMenu()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: /System default/ }))
  await act(async () => {})
  expect(state.assignments).toContainEqual({ workspaceId: 'folder:client', accountId: null })
})
