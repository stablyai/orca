// @vitest-environment happy-dom
// gh/glab living in a stopped WSL distro refuses the poll (E9); the card keeps its last numbers.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { useGitHubRateLimitSnapshot } from './github-rate-limit-display'
import { useGitLabRateLimitSnapshot } from '../gitlab/gitlab-rate-limit-display'

const STOPPED = "WSL distro 'Ubuntu' is not running. Open a terminal in it to start it."
const UNVERIFIABLE = "WSL didn't answer whether 'Ubuntu' is running, so Orca left it alone."
const SNAPSHOT = { fetchedAt: 1 }

const rateLimit = vi.fn()

beforeEach(() => {
  rateLimit.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { rateLimit }, gl: { rateLimit } }
  })
})

afterEach(() => {
  cleanup()
})

describe.each([
  ['GitHub', useGitHubRateLimitSnapshot],
  ['GitLab', useGitLabRateLimitSnapshot]
] as const)('%s rate-limit card', (_provider, useSnapshot) => {
  function renderCard() {
    return renderHook(() => useSnapshot({ kind: 'local' }, { autoRefresh: false }))
  }

  it.each([STOPPED, UNVERIFIABLE])(
    'keeps the last snapshot when refused with: %s',
    async (error) => {
      rateLimit.mockResolvedValueOnce({ ok: true, snapshot: SNAPSHOT })
      rateLimit.mockResolvedValueOnce({ ok: false, error })
      const { result } = renderCard()

      await act(() => result.current.refresh())
      await act(() => result.current.refresh())

      expect(result.current.snapshot).toEqual(SNAPSHOT)
      expect(result.current.hasError).toBe(false)
    }
  )

  it('keeps it when the refusal is thrown', async () => {
    rateLimit.mockResolvedValueOnce({ ok: true, snapshot: SNAPSHOT })
    rateLimit.mockRejectedValueOnce(new Error(STOPPED))
    const { result } = renderCard()

    await act(() => result.current.refresh())
    await act(() => result.current.refresh())

    expect(result.current.snapshot).toEqual(SNAPSHOT)
    expect(result.current.hasError).toBe(false)
  })

  it('reports the refusal when there is no snapshot yet to keep', async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, error: STOPPED })
    const { result } = renderCard()

    await act(() => result.current.refresh())

    expect(result.current.snapshot).toBeNull()
    expect(result.current.hasError).toBe(true)
  })

  it('still reports any other failure', async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, error: 'HTTP 401: Bad credentials' })
    const { result } = renderCard()

    await act(() => result.current.refresh())

    expect(result.current.hasError).toBe(true)
  })
})
