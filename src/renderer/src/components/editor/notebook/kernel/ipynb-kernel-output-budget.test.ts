import { describe, expect, it } from 'vitest'
import type { KernelOutputType } from '../../../../../../shared/notebook-kernel-types'
import { parseIpynbOutput } from '../document/ipynb-parse'
import { applyKernelOutput, toStoredOutputs, type LiveOutputs } from './ipynb-kernel-outputs'

const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }
type Frame = [KernelOutputType, Record<string, unknown>]

function apply(frames: Frame[], live = EMPTY): LiveOutputs {
  return frames.reduce(
    (current, [type, content]) => applyKernelOutput(current, type, content),
    live
  )
}

// 2.5 MiB of stdout in 64 KiB chunks.
function flood(): LiveOutputs {
  const chunk = 'x'.repeat(65536)
  return apply(Array.from({ length: 40 }, (): Frame => ['stream', { name: 'stdout', text: chunk }]))
}

describe('notebook cell output budget', () => {
  it('keeps the first 2 MiB of stream text, then one notice, and drops later chunks', () => {
    const live = flood()
    expect(live.outputs).toHaveLength(2)
    expect(live.outputs[0]).toEqual({
      output_type: 'stream',
      name: 'stdout',
      text: 'x'.repeat(2097152)
    })
    expect(live.outputs[1]?.output_type).toBe('display_data')
    expect(toStoredOutputs(live.outputs)).toEqual(live.outputs)

    const after = apply(
      [
        ['stream', { name: 'stdout', text: 'more' }],
        ['stream', { name: 'stderr', text: 'warn' }]
      ],
      live
    )
    expect(after).toBe(live)
  })

  it('leaves the previous display in place when its update does not fit', () => {
    const live = apply([
      [
        'display_data',
        { data: { 'text/plain': '0%' }, metadata: {}, transient: { display_id: 'p' } }
      ],
      [
        'update_display_data',
        {
          data: { 'image/png': 'A'.repeat(16777216) },
          metadata: {},
          transient: { display_id: 'p' }
        }
      ]
    ])
    expect(live.outputs).toHaveLength(2)
    expect(live.outputs[0]?.data).toEqual({ 'text/plain': '0%' })
    expect(live.outputs[1]?.output_type).toBe('display_data')
  })

  it('keeps the first error after truncation with its summary visible live and saved', () => {
    const live = applyKernelOutput(flood(), 'error', {
      ename: 'ValueError',
      evalue: 'Set API_TOKEN first.',
      traceback: ['Traceback (most recent call last):', 'z'.repeat(33554432), 'ValueError: ...']
    })
    expect(live.outputs.map((output) => output.output_type)).toEqual([
      'stream',
      'display_data',
      'error'
    ])
    const saved = toStoredOutputs(live.outputs)
    expect(saved).toEqual(live.outputs)
    const parsed = parseIpynbOutput(saved[2])
    if (parsed?.kind !== 'error') {
      throw new Error('Expected an error output')
    }
    expect(parsed.traceback.startsWith('Traceback (most recent call last):\nzzz')).toBe(true)
    expect(parsed.traceback.endsWith('\nValueError: Set API_TOKEN first.')).toBe(true)
  })
})
