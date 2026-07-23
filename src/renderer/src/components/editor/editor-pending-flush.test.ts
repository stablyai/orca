import { describe, expect, it, vi } from 'vitest'
import { flushPendingEditorChange, registerPendingEditorFlush } from './editor-pending-flush'

describe('editor pending flush registry', () => {
  it('releases a registered callback through its lifecycle disposer', () => {
    const flush = vi.fn()
    const unregister = registerPendingEditorFlush('/repo/file.md', flush)

    flushPendingEditorChange('/repo/file.md')
    unregister()
    flushPendingEditorChange('/repo/file.md')

    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('does not let an older disposer remove a replacement callback', () => {
    const olderFlush = vi.fn()
    const newerFlush = vi.fn()
    const unregisterOlder = registerPendingEditorFlush('/repo/file.md', olderFlush)
    const unregisterNewer = registerPendingEditorFlush('/repo/file.md', newerFlush)

    unregisterOlder()
    flushPendingEditorChange('/repo/file.md')
    unregisterNewer()
    flushPendingEditorChange('/repo/file.md')

    expect(olderFlush).not.toHaveBeenCalled()
    expect(newerFlush).toHaveBeenCalledTimes(1)
  })
})
