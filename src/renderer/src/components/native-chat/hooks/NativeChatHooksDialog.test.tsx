// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionHooks } from '../../../../../shared/agent-session/agent-session-hooks'
import NativeChatHooksDialog from './NativeChatHooksDialog'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc
}))
vi.mock('@/store', () => {
  const state = {
    modalData: { sessionId: 'chat', target: { kind: 'environment', environmentId: 'remote-host' } },
    closeModal: () => {}
  }
  return { useAppStore: (select: (value: typeof state) => unknown) => select(state) }
})
const listing: AgentSessionHooks = {
  scope: 'account-and-thread',
  cwd: '/workspace',
  live: true,
  warnings: [],
  hooks: [
    {
      key: 'project-hook',
      currentHash: 'reviewed-hash',
      command: 'node check.mjs',
      handlerType: 'command',
      eventName: 'preToolUse',
      source: 'project',
      sourcePath: '/workspace/.codex/hooks.json',
      enabled: false,
      isManaged: false,
      trustStatus: 'modified',
      timeoutSec: 10
    }
  ]
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('trusts the displayed command on its remote host and renders the confirmed disabled state', async () => {
  const write = Promise.withResolvers<AgentSessionHooks>()
  rpc.mockImplementation(async (target, method, params) => {
    if (
      target.environmentId !== 'remote-host' ||
      method !== 'agentSession.hooks' ||
      params.sessionId !== 'chat'
    ) {
      throw new Error('Wrong chat or host')
    }
    if (!params.trust) {
      return listing
    }
    if (
      JSON.stringify(params.trust) !==
      JSON.stringify({
        scope: 'account-and-thread',
        key: 'project-hook',
        currentHash: 'reviewed-hash'
      })
    ) {
      throw new Error('Trust did not match the displayed command')
    }
    return write.promise
  })
  render(<NativeChatHooksDialog />)
  await screen.findByText('node check.mjs')
  const button = screen.getByRole('button', { name: 'Trust this hook' })
  fireEvent.click(button)
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText('Trusted')).toBeNull()
  await act(async () =>
    write.resolve({ ...listing, hooks: [{ ...listing.hooks[0]!, trustStatus: 'trusted' }] })
  )
  expect(screen.getByText('Trusted')).toBeTruthy()
  expect(screen.getByText('Disabled. Trusting this hook will not enable it.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Trust this hook' })).toBeNull()
})

it('removes stale approval actions after a failed write until a fresh review succeeds', async () => {
  rpc
    .mockResolvedValueOnce(listing)
    .mockRejectedValueOnce(new Error('Hook changed'))
    .mockResolvedValueOnce({
      ...listing,
      hooks: [{ ...listing.hooks[0]!, command: 'node changed.mjs', currentHash: 'new-hash' }]
    })
  render(<NativeChatHooksDialog />)
  fireEvent.click(await screen.findByRole('button', { name: 'Trust this hook' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: 'Trust this hook' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('node changed.mjs')
  expect(screen.getByRole('button', { name: 'Trust this hook' })).toBeTruthy()
})

it('ignores a late read from the discarded StrictMode mount', async () => {
  const old = Promise.withResolvers<AgentSessionHooks>()
  rpc.mockReturnValueOnce(old.promise).mockResolvedValueOnce(listing)
  render(
    <StrictMode>
      <NativeChatHooksDialog />
    </StrictMode>
  )
  await screen.findByText('node check.mjs')
  await act(async () => old.reject(new Error('Old request failed')))
  expect(screen.getByRole('button', { name: 'Trust this hook' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
