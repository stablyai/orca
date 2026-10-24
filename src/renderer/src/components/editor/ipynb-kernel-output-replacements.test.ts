import { describe, expect, it, vi } from 'vitest'
import { applyKernelOutput, toStoredOutputs, type LiveOutputs } from './ipynb-kernel-outputs'
import { isRecord } from './ipynb-parse'

const LIMIT = 16 * 1024 * 1024
const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }
const bundle = (text: string, id = 'd', metadata = {}) => ({
  data: { 'text/plain': text },
  metadata,
  transient: { display_id: id }
})
const display = (live = EMPTY, text = 'small', id = 'd') =>
  applyKernelOutput(live, 'display_data', bundle(text, id))
const update = (live: LiveOutputs, text: string, id = 'd', metadata = {}) =>
  applyKernelOutput(live, 'update_display_data', bundle(text, id, metadata))
const noticeCount = (live: LiveOutputs) =>
  live.outputs.filter((output) => JSON.stringify(output.data ?? null).includes('Output truncated:'))
    .length

describe('notebook replacement output budget', () => {
  it('rejects growing displays at the aggregate budget and saves the previous display', () => {
    let live = display()
    live = update(live, 'x'.repeat(8 * 1024 * 1024))
    const previous = live.outputs[0]
    live = update(live, 'y'.repeat(LIMIT))
    expect(live.outputs[0] === previous).toBe(true)
    expect(noticeCount(live)).toBe(1)
    expect(toStoredOutputs(live.outputs)[0]?.data === previous?.data).toBe(true)
    expect(update(live, 'z'.repeat(40 * 1024 * 1024)) === live).toBe(true)
  })

  it('allows affordable replacements after truncation without another notice', () => {
    let live = display()
    live = applyKernelOutput(live, 'stream', { name: 'stdout', text: 'x'.repeat(3 * 1024 * 1024) })
    live = update(live, '100%')
    expect(live.outputs[0]?.data).toEqual({ 'text/plain': '100%' })
    expect(noticeCount(live)).toBe(1)
    const after = update(live, 'x'.repeat(LIMIT))
    expect(after === live).toBe(true)
    expect(noticeCount(after)).toBe(1)
  })

  it('charges every display replaced by one display ID', () => {
    const live = display(display())
    const updated = update(live, 'x'.repeat(9 * 1024 * 1024))
    expect(updated.outputs[0] === live.outputs[0] && updated.outputs[1] === live.outputs[1]).toBe(
      true
    )
    expect(noticeCount(updated)).toBe(1)
    const small = update(updated, 'done')
    expect(small.outputs.slice(0, 2).map((output) => output.data)).toEqual([
      { 'text/plain': 'done' },
      { 'text/plain': 'done' }
    ])
  })

  it('stops serializing a rejected replacement after the first matching output exceeds the limit', () => {
    let live = EMPTY
    for (let index = 0; index < 2000; index += 1) {
      live = display(live)
    }
    const content = bundle('x'.repeat(LIMIT + 1024))
    const stringify = JSON.stringify
    let measurements = 0
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (isRecord(value) && value.data === content.data) {
        measurements += 1
        if (measurements > 1) {
          throw new Error('Oversized replacement measured again after admission failed')
        }
      }
      return stringify(value)
    })
    try {
      const capped = applyKernelOutput(live, 'update_display_data', content)
      expect(capped.outputs[0] === live.outputs[0]).toBe(true)
      expect(measurements).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('charges metadata on appends and replacements, and transient display IDs on appends', () => {
    const metadata = { custom: 'x'.repeat(LIMIT) }
    const appended = applyKernelOutput(EMPTY, 'display_data', bundle('tiny', 'd', metadata))
    expect(appended.outputs).toHaveLength(1)
    expect(noticeCount(appended)).toBe(1)
    const live = display()
    const replaced = update(live, 'tiny', 'd', metadata)
    expect(replaced.outputs[0]).toBe(live.outputs[0])
    expect(noticeCount(replaced)).toBe(1)
    const hugeId = display(EMPTY, 'tiny', 'd'.repeat(LIMIT))
    expect(hugeId.outputs).toHaveLength(1)
    expect(noticeCount(hugeId)).toBe(1)
  })

  it('caps cumulative metadata, even when every individual output is small', () => {
    let live = EMPTY
    for (let index = 0; index < 32; index += 1) {
      live = applyKernelOutput(live, 'display_data', {
        data: { 'text/plain': String(index) },
        metadata: { custom: 'z'.repeat(1024 * 1024) }
      })
    }
    expect(noticeCount(live)).toBe(1)
    expect(JSON.stringify(live.outputs).length).toBeLessThan(LIMIT + 1024)
  })

  it('does not notify for an update with no matching display, including after wait-clear', () => {
    const live = display()
    expect(update(live, 'ignored', 'missing')).toBe(live)
    const waited = applyKernelOutput(live, 'clear_output', { wait: true })
    expect(update(waited, 'ignored', 'missing')).toBe(waited)
    const updated = update(waited, 'progress')
    expect(updated.clearOnNextOutput).toBe(true)
    const fresh = applyKernelOutput(updated, 'stream', { name: 'stdout', text: 'fresh' })
    expect(fresh.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'fresh' }])
  })

  it.each([false, true])('resets a rejected replacement after clear_output wait=%s', (wait) => {
    const capped = update(display(), 'x'.repeat(LIMIT))
    const cleared = applyKernelOutput(capped, 'clear_output', { wait })
    const fresh = display(cleared, 'fresh')
    const updated = update(fresh, 'ok')
    expect(updated.outputs).toHaveLength(1)
    expect(updated.outputs[0]?.data).toEqual({ 'text/plain': 'ok' })
    expect(noticeCount(updated)).toBe(0)
  })

  it('rejects a new stream block at the output-count cap', () => {
    let live = EMPTY
    for (let index = 0; index < 2000; index += 1) {
      live = display(live, String(index), String(index))
    }
    const capped = applyKernelOutput(live, 'stream', { name: 'stderr', text: 'late' })
    expect(capped.outputs.slice(0, -1)).toEqual(live.outputs)
    expect(noticeCount(capped)).toBe(1)
  })
})
