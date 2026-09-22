import { describe, expect, it } from 'vitest'
import {
  isLocalSessionTabCloseOwned,
  withLocalSessionTabCloseOwner
} from './local-session-tab-close-owner'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('local session tab close ownership', () => {
  it('scopes ownership to the exact workspace and tab until host acknowledgement', async () => {
    const host = deferred()
    const closing = withLocalSessionTabCloseOwner('folder:one', 'chat', () => host.promise)
    expect(isLocalSessionTabCloseOwned('folder:one', 'chat')).toBe(true)
    expect(isLocalSessionTabCloseOwned('folder:two', 'chat')).toBe(false)
    expect(isLocalSessionTabCloseOwned('folder:one', 'other-chat')).toBe(false)
    host.resolve()
    await closing
    expect(isLocalSessionTabCloseOwned('folder:one', 'chat')).toBe(false)
  })

  it('releases ownership on host failure so a later close must be authorized again', async () => {
    await expect(
      withLocalSessionTabCloseOwner('wt', 'chat', async () => {
        throw new Error('host unavailable')
      })
    ).rejects.toThrow('host unavailable')
    expect(isLocalSessionTabCloseOwned('wt', 'chat')).toBe(false)
  })

  it('keeps overlapping handoffs owned until both have settled', async () => {
    const first = deferred()
    const second = deferred()
    const firstClose = withLocalSessionTabCloseOwner('wt', 'chat', () => first.promise)
    const secondClose = withLocalSessionTabCloseOwner('wt', 'chat', () => second.promise)
    first.resolve()
    await firstClose
    expect(isLocalSessionTabCloseOwned('wt', 'chat')).toBe(true)
    second.resolve()
    await secondClose
    expect(isLocalSessionTabCloseOwned('wt', 'chat')).toBe(false)
  })
})
