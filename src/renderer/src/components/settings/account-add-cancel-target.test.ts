import { describe, expect, it, vi } from 'vitest'

const cancelHost = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/runtime/runtime-host-account-sign-in-client', () => ({
  cancelHostAccountSignIn: cancelHost,
  isLostHostAnswer: () => false
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import {
  accountAdditionShownInPrompt,
  cancelAccountAddition,
  trackAccountAddition
} from './account-add-cancel-target'

const SERVER = { kind: 'environment', environmentId: 'server' } as const
const LOCAL = { kind: 'local' } as const

describe('account addition Cancel target', () => {
  it('cancels the server sign-in even after Settings moved to this desktop', async () => {
    const running = Promise.withResolvers<void>()
    const adding = trackAccountAddition('claude', SERVER, () => running.promise)
    const cancelLocal = vi.fn(async () => true)
    expect(accountAdditionShownInPrompt('claude', LOCAL)).toBe(false)
    expect(accountAdditionShownInPrompt('claude', SERVER)).toBe(true)
    await cancelAccountAddition('claude', cancelLocal)
    expect(cancelHost).toHaveBeenCalledWith(SERVER, 'claude')
    expect(cancelLocal).not.toHaveBeenCalled()
    running.resolve()
    await adding
    expect(accountAdditionShownInPrompt('claude', SERVER)).toBe(false)
  })

  it('cancels this desktop’s own login for a local addition', async () => {
    cancelHost.mockClear()
    const running = Promise.withResolvers<void>()
    const adding = trackAccountAddition('codex', LOCAL, () => running.promise)
    const cancelLocal = vi.fn(async () => true)
    await cancelAccountAddition('codex', cancelLocal)
    expect(cancelLocal).toHaveBeenCalledOnce()
    expect(cancelHost).not.toHaveBeenCalled()
    running.resolve()
    await adding
  })
})
