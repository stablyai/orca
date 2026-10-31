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
vi.mock('@/lib/window-visibility-interval', () => ({ isWindowVisible: () => true }))

import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { useRefreshOnHostContact } from './use-refresh-on-host-contact'

afterEach(() => {
  cleanup()
  contact.listeners.clear()
})

// QA F1: Source Control showed "clean" after a relaunch while the guest had a modified file.
it('reads Git status again when the runtime host answers, while it may fetch', () => {
  const scheduler = { current: { refreshNow: vi.fn() } }
  const canFetch = { current: true }
  renderHook(() =>
    useRefreshOnHostContact(toRuntimeExecutionHostId('wsl:ubuntu'), scheduler, canFetch)
  )
  contact.listeners.get('wsl:ubuntu')?.()
  expect(scheduler.current.refreshNow).toHaveBeenCalledOnce()

  canFetch.current = false
  contact.listeners.get('wsl:ubuntu')?.()
  expect(scheduler.current.refreshNow).toHaveBeenCalledOnce()
})

it('does nothing for a workspace on this computer', () => {
  renderHook(() =>
    useRefreshOnHostContact('local', { current: { refreshNow: vi.fn() } }, { current: true })
  )
  expect(contact.listeners.size).toBe(0)
})
