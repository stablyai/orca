// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  message: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks.message }))

import type { LanguageServerStatusEvent } from '../../../../../shared/language-server-navigation-types'
import {
  applyLanguageServerStatusEvent,
  installLanguageServerStatusSubscriber
} from './language-server-status-subscriber'
import {
  getLanguageServerStatus,
  resetLanguageServerStatusForTests,
  subscribeLanguageServerStatus
} from './language-server-status-store'

beforeEach(() => {
  resetLanguageServerStatusForTests()
  toastMocks.message.mockReset()
})

describe('applyLanguageServerStatusEvent — progress', () => {
  it('stores the $/progress projection and clears it on null', () => {
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing 42%' })
    expect(getLanguageServerStatus().progress).toBe('clangd: indexing 42%')
    applyLanguageServerStatusEvent({ kind: 'progress', text: null })
    expect(getLanguageServerStatus().progress).toBeNull()
  })

  it('does not touch the degraded hint when a progress event arrives', () => {
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'consider an upgrade' })
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing' })
    expect(getLanguageServerStatus().degraded).toBe('consider an upgrade')
  })
})

describe('applyLanguageServerStatusEvent — degraded', () => {
  it('stores a persistent install hint and clears it on null', () => {
    applyLanguageServerStatusEvent({ kind: 'degraded', message: 'install clangd 12+' })
    expect(getLanguageServerStatus().degraded).toBe('install clangd 12+')
    applyLanguageServerStatusEvent({ kind: 'degraded', message: null })
    expect(getLanguageServerStatus().degraded).toBeNull()
  })
})

describe('applyLanguageServerStatusEvent — toast (LRU eviction)', () => {
  it('routes a one-shot toast to sonner and leaves progress/degraded untouched', () => {
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing' })
    applyLanguageServerStatusEvent({ kind: 'toast', message: 'language server evicted' })
    expect(toastMocks.message).toHaveBeenCalledWith('language server evicted')
    expect(getLanguageServerStatus().progress).toBe('clangd: indexing')
    expect(getLanguageServerStatus().degraded).toBeNull()
  })
})

describe('subscribeLanguageServerStatus', () => {
  it('notifies listeners with an immutable snapshot on each event', () => {
    const seen: string[] = []
    const unsubscribe = subscribeLanguageServerStatus((state) => {
      seen.push(`${state.progress ?? '-'}|${state.degraded ?? '-'}`)
    })
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'clangd: indexing 10%' })
    applyLanguageServerStatusEvent({ kind: 'progress', text: null })
    unsubscribe()
    applyLanguageServerStatusEvent({ kind: 'progress', text: 'unseen' })
    expect(seen).toEqual(['clangd: indexing 10%|-', '-|-'])
  })
})

describe('installLanguageServerStatusSubscriber', () => {
  it('wires the window api onStatus push into the store', () => {
    const pushed: ((event: LanguageServerStatusEvent) => void)[] = []
    const unsubscribe = vi.fn()
    const api = {
      onStatus: (callback: (event: LanguageServerStatusEvent) => void) => {
        pushed.push(callback)
        return unsubscribe
      }
    }
    const uninstall = installLanguageServerStatusSubscriber(api)
    pushed[0]?.({ kind: 'progress', text: 'clangd: indexing 99%' })
    expect(getLanguageServerStatus().progress).toBe('clangd: indexing 99%')

    uninstall()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
