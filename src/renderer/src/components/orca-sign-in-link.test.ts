// COPY-LINK-FIRST-CLICK: the first "Sign in" / "Continue in browser" copies the link of the same
// trip a click would make, started without the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { mintFirstClickLink } from './orca-sign-in-link'

const progress = (link: string | null) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the minter reads only the link.
  ({ link }) as never

beforeEach(() => {
  useAppStore.setState({ orcaProfileSignInProgress: null })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the first click's Copy link", () => {
  it('a sign-in already out: copies its link and starts nothing', async () => {
    useAppStore.setState({ orcaProfileSignInProgress: progress('https://auth/a?state=1') })
    const start = vi.fn()
    await expect(mintFirstClickLink(start)).resolves.toBe('https://auth/a?state=1')
    expect(start).not.toHaveBeenCalled()
  })

  it('starts the sign-in without the browser and copies the link main publishes', async () => {
    const start = vi.fn(() => {
      setTimeout(() =>
        useAppStore.setState({ orcaProfileSignInProgress: progress('https://auth/b') })
      )
    })
    await expect(mintFirstClickLink(start)).resolves.toBe('https://auth/b')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('signed in, setup hands its session link back directly', async () => {
    await expect(mintFirstClickLink((deliver) => deliver('https://setup/s'))).resolves.toBe(
      'https://setup/s'
    )
  })

  it('no link (no setup, or nothing published in time): the copy fails rather than copying nothing', async () => {
    await expect(mintFirstClickLink((deliver) => deliver(null))).rejects.toThrow()
    vi.useFakeTimers()
    const waiting = mintFirstClickLink(() => undefined, 1_000)
    const settled = expect(waiting).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(1_000)
    await settled
  })
})
