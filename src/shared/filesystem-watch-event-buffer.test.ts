import { describe, expect, it } from 'vitest'
import type { FsChangeEvent } from './filesystem-entry-types'
import { FileWatchEventBuffer } from './filesystem-watch-event-buffer'

describe('FileWatchEventBuffer', () => {
  it('preserves precise event order and releases a consumed batch', () => {
    const buffer = new FileWatchEventBuffer()
    const events: FsChangeEvent[] = [
      { kind: 'delete', absolutePath: '/repo/old/file.ts' },
      { kind: 'create', absolutePath: '/repo/new/file.ts' },
      {
        kind: 'rename',
        absolutePath: '/repo/new',
        oldAbsolutePath: '/repo/old'
      }
    ]
    buffer.push(events.slice(0, 1))
    buffer.push(events.slice(1))
    expect(buffer.take()).toEqual(events)
    expect(buffer.size).toBe(0)
    expect(buffer.take()).toEqual([])
  })

  it('retains an explicit overflow until consumed without retaining later paths', () => {
    const buffer = new FileWatchEventBuffer()
    const overflow: FsChangeEvent = { kind: 'overflow', absolutePath: '/repo' }
    buffer.push([{ kind: 'delete', absolutePath: '/repo/deleted.ts' }])
    buffer.push([overflow])
    buffer.push([{ kind: 'update', absolutePath: '/repo/later.ts' }])
    expect(buffer.size).toBe(1)
    expect(buffer.take()).toEqual([overflow])
  })

  it('clears events and overflow debt on owner disposal', () => {
    const buffer = new FileWatchEventBuffer()
    buffer.push([{ kind: 'overflow', absolutePath: '/repo' }])
    buffer.clear()
    expect(buffer.size).toBe(0)
    buffer.push([{ kind: 'create', absolutePath: '/new-repo/new.ts' }])
    expect(buffer.take()).toEqual([{ kind: 'create', absolutePath: '/new-repo/new.ts' }])
  })
})
