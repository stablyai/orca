import { describe, expect, it, vi } from 'vitest'
import { clearQueuedInitialCwdAfterFirstPane, resolveQueuedInitialCwd } from './queued-initial-cwd'

describe('resolveQueuedInitialCwd', () => {
  it('consumes the queued initial cwd once when the ref is unset', () => {
    const consumeTabInitialCwd = vi.fn(() => '/repo/packages/web')

    expect(resolveQueuedInitialCwd(undefined, consumeTabInitialCwd, '/repo')).toEqual({
      queuedInitialCwd: '/repo/packages/web',
      startupCwd: '/repo/packages/web'
    })
    expect(consumeTabInitialCwd).toHaveBeenCalledTimes(1)
  })

  it('reuses the existing queued state without re-reading the store', () => {
    const consumeTabInitialCwd = vi.fn(() => '/repo/packages/web')

    expect(resolveQueuedInitialCwd(null, consumeTabInitialCwd, '/repo')).toEqual({
      queuedInitialCwd: null,
      startupCwd: '/repo'
    })
    expect(resolveQueuedInitialCwd('/repo/packages/web', consumeTabInitialCwd, '/repo')).toEqual({
      queuedInitialCwd: '/repo/packages/web',
      startupCwd: '/repo/packages/web'
    })
    expect(consumeTabInitialCwd).not.toHaveBeenCalled()
  })
})

describe('clearQueuedInitialCwdAfterFirstPane', () => {
  it('clears the one-shot cwd and restores the default cwd after the first pane', () => {
    expect(
      clearQueuedInitialCwdAfterFirstPane('/repo/packages/web', '/repo', '/repo/packages/web')
    ).toEqual({
      queuedInitialCwd: null,
      ptyCwd: '/repo'
    })
  })

  it('leaves the cwd unchanged when no one-shot override is queued', () => {
    expect(clearQueuedInitialCwdAfterFirstPane(null, '/repo', '/repo')).toEqual({
      queuedInitialCwd: null,
      ptyCwd: '/repo'
    })
  })
})
