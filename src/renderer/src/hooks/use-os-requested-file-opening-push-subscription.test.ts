// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// Why: a plain rejecting function, not vi.fn() — vi.fn()'s own call-result tracking
// attaches a rejection handler internally, which silently defeats the process-level
// "unhandled rejection" check below regardless of whether the fix under test is present.
const openOsRequestedFileHolder = vi.hoisted(() => ({
  impl: (_filePath: string) => Promise.resolve() as Promise<void>
}))

vi.mock('@/lib/open-os-requested-file', () => ({
  openOsRequestedFile: (filePath: string) => openOsRequestedFileHolder.impl(filePath)
}))

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string) => value
}))

import { useOsRequestedFileOpening } from './use-os-requested-file-opening'

const UNHANDLED_REJECTION_SETTLE_MS = 20

// Why: mirrors monaco-delayer-cancellation-guard.test.ts's proof pattern for "no unhandled rejection".
async function collectUnhandledRejections(run: () => void): Promise<unknown[]> {
  const reasons: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    reasons.push(reason)
  }

  process.on('unhandledRejection', onUnhandledRejection)
  try {
    run()
    await new Promise((resolve) => setTimeout(resolve, UNHANDLED_REJECTION_SETTLE_MS))
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }

  return reasons
}

beforeEach(() => {
  toastErrorMock.mockClear()
  openOsRequestedFileHolder.impl = () => Promise.resolve()
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useOsRequestedFileOpening push subscription', () => {
  it('reports a rejected push-delivered file without producing an unhandled rejection', async () => {
    let pushListener: ((filePath: string) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      osFileOpen: {
        onOpened: vi.fn((listener: (filePath: string) => void) => {
          pushListener = listener
          return vi.fn()
        })
      }
    }
    openOsRequestedFileHolder.impl = () => Promise.reject(new Error('boom'))

    renderHook(() => useOsRequestedFileOpening())
    expect(pushListener).toBeDefined()

    const unhandledRejections = await collectUnhandledRejections(() => {
      pushListener?.('/Users/x/projects/a.md')
    })

    expect(unhandledRejections).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })
})
