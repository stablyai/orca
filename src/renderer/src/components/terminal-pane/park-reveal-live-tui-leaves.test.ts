import { describe, expect, it } from 'vitest'
import { resolveParkRevealLiveTuiLeafIds } from './park-reveal-live-tui-leaves'

describe('resolveParkRevealLiveTuiLeafIds', () => {
  const bindings = { remoteLeaf: 'remote:env-1@@terminal-1', localLeaf: 'wt-1@@abcd1234' }

  it('keeps only remote leaves on a park-reveal mount', () => {
    expect(resolveParkRevealLiveTuiLeafIds(true, bindings)).toEqual(new Set(['remoteLeaf']))
  })

  // Why: a restart or plain remount restores a TUI that no longer runs, so it must leave alt.
  it('keeps nothing when the mount does not follow a park', () => {
    expect(resolveParkRevealLiveTuiLeafIds(false, bindings)).toBeUndefined()
  })
})
