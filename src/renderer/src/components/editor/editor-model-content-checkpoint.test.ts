import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushEditorModelContentCheckpoint,
  isCurrentEditorModelContent,
  isStaleEditorModelContent,
  registerEditorModelContentCheckpoint,
  withEditorModelContentSync
} from './editor-model-content-checkpoint'
import {
  flushPendingEditorChange,
  hasPendingEditorChange,
  subscribePendingEditorChanges
} from './editor-pending-flush'
import { createCheckpointModelFixture } from './editor-model-checkpoint-test-fixture'

const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.useRealTimers()
})

describe('model content checkpoints', () => {
  it('avoids full-text reads per input and shares one checkpoint across split panes', () => {
    const fixture = createCheckpointModelFixture()
    const first = vi.fn()
    const second = vi.fn()
    const pending = vi.fn()
    const input = vi.fn()
    cleanups.push(
      registerEditorModelContentCheckpoint(fixture.model, {
        fileId: 'shared',
        publish: first,
        onPending: pending
      }),
      registerEditorModelContentCheckpoint(fixture.model, { fileId: 'shared', publish: second }),
      subscribePendingEditorChanges(input)
    )
    for (let index = 0; index < 1_000; index++) {
      fixture.edit(`input-${index}`)
    }
    expect(fixture.model.getValue).not.toHaveBeenCalled()
    expect(fixture.listenerCount()).toBe(1)
    expect(pending).toHaveBeenCalledOnce()
    expect(input).toHaveBeenCalledWith('shared')
    expect(hasPendingEditorChange('shared')).toBe(true)
    vi.advanceTimersByTime(150)
    expect(fixture.model.getValue).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledExactlyOnceWith('input-999')
    expect(second).toHaveBeenCalledExactlyOnceWith('input-999')
    expect(hasPendingEditorChange('shared')).toBe(false)
    flushPendingEditorChange('shared')
    expect(fixture.model.getValue).toHaveBeenCalledOnce()
  })

  it('materializes continuous input within 500ms and releases its timer at idle', () => {
    const fixture = createCheckpointModelFixture()
    const published: { content: string; time: number }[] = []
    cleanups.push(
      registerEditorModelContentCheckpoint(fixture.model, {
        publish: (content) => published.push({ content, time: Date.now() })
      })
    )
    const start = Date.now()
    for (let index = 0; index < 30; index++) {
      fixture.edit(`input-${index}`)
      vi.advanceTimersByTime(100)
    }
    expect(published.map(({ time }) => time - start)).toEqual([500, 1000, 1500, 2000, 2500, 3000])
    expect(published.at(-1)?.content).toBe('input-29')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes every section owned by a file before closing, even before the first timer', () => {
    const first = createCheckpointModelFixture()
    const second = createCheckpointModelFixture()
    const publishFirst = vi.fn()
    const publishSecond = vi.fn()
    cleanups.push(
      registerEditorModelContentCheckpoint(first.model, {
        fileId: 'combined',
        publish: publishFirst
      }),
      registerEditorModelContentCheckpoint(second.model, {
        fileId: 'combined',
        publish: publishSecond
      })
    )
    first.edit('last first section input')
    second.edit('last second section input')
    flushPendingEditorChange('combined')
    expect(publishFirst).toHaveBeenCalledExactlyOnceWith('last first section input')
    expect(publishSecond).toHaveBeenCalledExactlyOnceWith('last second section input')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes the pinned model on disposal and does not leave an input subscription', () => {
    const fixture = createCheckpointModelFixture()
    const publish = vi.fn()
    const unregister = registerEditorModelContentCheckpoint(fixture.model, {
      fileId: 'dispose',
      publish
    })
    fixture.edit('final before disposal')
    fixture.dispose()
    expect(publish).toHaveBeenCalledExactlyOnceWith('final before disposal')
    expect(fixture.listenerCount()).toBe(0)
    unregister()
    expect(hasPendingEditorChange('dispose')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores programmatic and suppressed input without reading the full model', () => {
    const fixture = createCheckpointModelFixture()
    let ignore = true
    const publish = vi.fn()
    cleanups.push(
      registerEditorModelContentCheckpoint(fixture.model, { publish, shouldIgnore: () => ignore })
    )
    fixture.edit('read only or large paste chunk')
    ignore = false
    withEditorModelContentSync(fixture.model, () => fixture.edit('external reload'))
    vi.advanceTimersByTime(1_000)
    expect(fixture.model.getValue).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    fixture.edit('actual input')
    flushEditorModelContentCheckpoint(fixture.model)
    expect(publish).toHaveBeenCalledExactlyOnceWith('actual input')
  })

  it('recognizes stale prop echoes and preserves a reentrant edit for the next flush', () => {
    const fixture = createCheckpointModelFixture()
    const published: string[] = []
    cleanups.push(
      registerEditorModelContentCheckpoint(fixture.model, {
        fileId: 'reentrant',
        publish: (content) => {
          published.push(content)
          if (content === 'first') {
            fixture.edit('second')
          }
        }
      })
    )
    fixture.edit('first')
    flushPendingEditorChange('reentrant')
    expect(isStaleEditorModelContent(fixture.model, 'first')).toBe(true)
    expect(isCurrentEditorModelContent(fixture.model, 'first')).toBe(false)
    expect(isStaleEditorModelContent(fixture.model, 'actual external replacement')).toBe(false)
    expect(hasPendingEditorChange('reentrant')).toBe(true)
    flushPendingEditorChange('reentrant')
    expect(published).toEqual(['first', 'second'])
    expect(isCurrentEditorModelContent(fixture.model, 'second')).toBe(true)
  })
})
