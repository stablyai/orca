// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { GitHubParticipantSettings } from './GitHubParticipantSettings'
import { applyGitHubParticipantAccountsChanged } from '@/runtime/github-participant-account-changes'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { GitHubParticipantSettingsStatus } from '../../../../../shared/github/participant-accounts'

const { rpc, evict } = vi.hoisted(() => ({ rpc: vi.fn(), evict: vi.fn() }))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ evictGitHubRepoCaches: evict }) }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('../../ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children
  }: {
    value: string
    disabled?: boolean
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))
const alice = { host: 'github.com', user: 'alice' }
const target = { kind: 'environment', environmentId: 'server-1' } as const
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  rpc.mockReset()
  evict.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(repoId = 'repo-1') {
  await act(async () =>
    root.render(
      <GitHubParticipantSettings repoId={repoId} runtimeTarget={target} inventory={null}>
        <button>Shared account</button>
      </GitHubParticipantSettings>
    )
  )
}
function configure(status: GitHubParticipantSettingsStatus) {
  rpc.mockImplementation(async (_target, method) =>
    method === 'status.get' ? { capabilities: ['github-participant-accounts-v1'] } : status
  )
}
it('preserves legacy controls without sending participant RPCs to an old host', async () => {
  rpc.mockResolvedValue({ capabilities: [] })
  await render()
  expect(container.textContent).toContain('Shared account')
  expect(rpc).toHaveBeenCalledTimes(1)
})
it('shows an unenrolled device action without exposing the shared account', async () => {
  configure({ enabled: true, isOwner: false, allowedAccounts: [] })
  await render()
  expect(container.textContent).toContain('Ask the server owner')
  expect(container.textContent).not.toContain('Shared account')
  expect(container.querySelector('select')).toBeNull()
})
it('selects only a member account on the target host, without an ambient fallback', async () => {
  configure({
    enabled: true,
    isOwner: false,
    participantId: 'p-1',
    participantName: 'Alice',
    allowedAccounts: [alice]
  })
  await render()
  expect(container.textContent).toContain('Alice')
  expect(container.textContent).not.toContain('Shared account')
  const select = container.querySelector('select')
  if (!select) {
    throw new Error('Missing personal account selector')
  }
  const option = Array.from(select.options).find((o) =>
    o.textContent?.includes('alice @ github.com')
  )
  if (!option) {
    throw new Error('Missing account option')
  }
  await act(async () => {
    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(rpc).toHaveBeenCalledWith(target, 'github.participants.select', {
    repo: 'repo-1',
    account: alice
  })
  expect(container.textContent).not.toContain('ambient')
})
it('fails closed when an advertised host cannot load member status', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { capabilities: ['github-participant-accounts-v1'] }
    }
    throw new Error('Server unreachable')
  })
  await render()
  expect(container.textContent).toContain('Server unreachable')
  expect(container.textContent).not.toContain('Shared account')
})
it('lets the owner explicitly enable per-member accounts', async () => {
  configure({ enabled: false, isOwner: true, allowedAccounts: [], participants: [], devices: [] })
  await render()
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
  if (!toggle) {
    throw new Error('Missing owner control')
  }
  await act(async () => toggle.click())
  expect(rpc).toHaveBeenCalledWith(target, 'github.participants.setEnabled', {
    repo: 'repo-1',
    enabled: true
  })
})
it('saves a member with multiple paired devices and only keyring accounts', async () => {
  configure({
    enabled: true,
    isOwner: true,
    allowedAccounts: [],
    participants: [],
    devices: [
      { deviceId: 'phone', name: 'Phone' },
      { deviceId: 'laptop', name: 'Laptop' }
    ]
  })
  await act(async () =>
    root.render(
      <GitHubParticipantSettings
        repoId="repo-1"
        runtimeTarget={target}
        inventory={{
          capability: 'supported',
          accounts: [
            { ...alice, active: true, source: 'keyring', envToken: null, scopes: [] },
            {
              host: 'github.com',
              user: 'env-bot',
              active: false,
              source: 'env',
              envToken: 'GH_TOKEN',
              scopes: []
            }
          ]
        }}
      >
        <button>Shared account</button>
      </GitHubParticipantSettings>
    )
  )
  const add = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Add member'
  )
  if (!add) {
    throw new Error('Missing add member button')
  }
  await act(async () => add.click())
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('Missing member name')
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Alice')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.textContent).not.toContain('env-bot')
  for (const checkbox of container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')) {
    await act(async () => checkbox.click())
  }
  await act(async () =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  )
  expect(rpc).toHaveBeenCalledWith(target, 'github.participants.save', {
    repo: 'repo-1',
    id: undefined,
    name: 'Alice',
    deviceIds: ['phone', 'laptop'],
    allowedAccounts: [alice]
  })
})
it('discards a previous project response after switching projects', async () => {
  let finishFirst: ((value: unknown) => void) | undefined
  rpc.mockImplementation(async (_target, method, params) => {
    if (method === 'status.get') {
      return { capabilities: ['github-participant-accounts-v1'] }
    }
    if (params.repo === 'repo-1') {
      return new Promise((resolve) => {
        finishFirst = resolve
      })
    }
    return {
      enabled: true,
      isOwner: false,
      participantId: 'p-2',
      participantName: 'Bob',
      allowedAccounts: []
    }
  })
  await render('repo-1')
  await render('repo-2')
  await act(async () => finishFirst?.({ enabled: false, isOwner: true, allowedAccounts: [] }))
  expect(container.textContent).toContain('Bob')
  expect(container.textContent).not.toContain('Shared account')
})
it('requires confirmation before removing a member and keeps assignments on a failed save', async () => {
  configure({
    enabled: true,
    isOwner: true,
    allowedAccounts: [],
    participants: [{ id: 'p-1', name: 'Alice', deviceIds: ['phone'], allowedAccounts: [alice] }],
    devices: [{ deviceId: 'phone', name: 'Phone' }]
  })
  await render()
  const remove = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Remove'
  )
  if (!remove) {
    throw new Error('Missing remove button')
  }
  await act(async () => remove.click())
  expect(rpc.mock.calls.some((call) => call[1] === 'github.participants.remove')).toBe(false)
  expect(container.textContent).toContain('Remove Alice from this server?')
  rpc.mockRejectedValueOnce(new Error('Cannot remove member'))
  const confirm = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Remove member'
  )
  if (!confirm) {
    throw new Error('Missing confirmation button')
  }
  await act(async () => confirm.click())
  expect(rpc).toHaveBeenCalledWith(target, 'github.participants.remove', {
    repo: 'repo-1',
    id: 'p-1'
  })
  expect(container.textContent).toContain('Cannot remove member')
  expect(container.textContent).toContain('Alice')
})

it('fails closed when an advertised member method is unavailable', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { capabilities: ['github-participant-accounts-v1'] }
    }
    throw new RuntimeRpcCallError({
      id: 'participant-status',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
  })
  await render()
  expect(container.textContent).not.toContain('Shared account')
  expect(container.textContent).toContain('Unknown method')
  expect(container.textContent).toContain('Retry')
})

it('evicts target-project account caches when member access is learned and selection changes', async () => {
  const status = { enabled: true, isOwner: false, participantId: 'p-1', allowedAccounts: [alice] }
  configure(status)
  await render()
  expect(evict).toHaveBeenCalledWith('repo-1', undefined, 'runtime:server-1')
  evict.mockClear()
  rpc.mockResolvedValueOnce({ ...status, selectedAccount: alice })
  const select = container.querySelector('select')
  if (!select) {
    throw new Error('Missing account selector')
  }
  await act(async () => {
    select.value = JSON.stringify([alice.host, alice.user])
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(evict).toHaveBeenCalledTimes(1)
  expect(evict).toHaveBeenCalledWith('repo-1', undefined, 'runtime:server-1')
})
it('shows server account availability errors even when an account is selected', async () => {
  configure({
    enabled: true,
    isOwner: false,
    participantId: 'p-1',
    allowedAccounts: [alice],
    selectedAccount: alice,
    error: 'Your GitHub account is unavailable. Ask the server owner to sign in again.'
  })
  await render()
  expect(container.textContent).toContain('Your GitHub account is unavailable')
  expect(container.textContent).not.toContain('Shared account')
})

it('reloads member status when another device changes its selection', async () => {
  configure({
    enabled: true,
    isOwner: false,
    participantId: 'p-1',
    participantName: 'Alice',
    allowedAccounts: [alice],
    selectedAccount: alice
  })
  await render()
  configure({
    enabled: true,
    isOwner: false,
    participantId: 'p-2',
    participantName: 'Bob',
    allowedAccounts: []
  })
  await act(async () => applyGitHubParticipantAccountsChanged(target))
  expect(container.textContent).toContain('Bob')
  expect(container.textContent).not.toContain('Alice')
  expect(container.textContent).not.toContain('Shared account')
})
it('does not restore an older selection receipt after a peer change has refreshed status', async () => {
  const bob = { host: 'github.com', user: 'bob' }
  const status = {
    enabled: true,
    isOwner: false,
    participantId: 'p-1',
    allowedAccounts: [alice, bob]
  }
  const selection = Promise.withResolvers<unknown>()
  let latest = { ...status, selectedAccount: alice }
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { capabilities: ['github-participant-accounts-v1'] }
    }
    if (method === 'github.participants.select') {
      return selection.promise
    }
    return latest
  })
  await render()
  const select = container.querySelector('select')
  if (!select) {
    throw new Error('Missing account selector')
  }
  await act(async () => {
    select.value = JSON.stringify([bob.host, bob.user])
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  latest = { ...status, selectedAccount: bob }
  await act(async () => applyGitHubParticipantAccountsChanged(target))
  await act(async () => selection.resolve({ ...status, selectedAccount: alice }))
  expect(container.querySelector('select')?.value).toBe(JSON.stringify([bob.host, bob.user]))
})
