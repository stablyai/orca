import { describe, expect, it } from 'vitest'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import {
  applyKernelOutput,
  collapseCarriageReturns,
  toStoredOutputs,
  type LiveOutputs
} from './ipynb-kernel-outputs'

const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }

function apply(messages: [KernelOutputType, Record<string, unknown>][]): LiveOutputs {
  return messages.reduce((live, [type, content]) => applyKernelOutput(live, type, content), EMPTY)
}

describe('collapseCarriageReturns', () => {
  it('keeps only the last rewrite of each line, like a terminal', () => {
    expect(collapseCarriageReturns('10%\r50%\r100%\ndone\n')).toBe('100%\ndone\n')
  })

  it('treats \\r\\n as a newline and keeps a trailing \\r for the next chunk', () => {
    expect(collapseCarriageReturns('a\r\nb')).toBe('a\nb')
    expect(collapseCarriageReturns('x\r1%\r')).toBe('1%\r')
  })
})

describe('applyKernelOutput', () => {
  it('merges consecutive chunks of one stream and collapses progress rewrites across them', () => {
    const live = apply([
      ['stream', { name: 'stdout', text: 'step 1' }],
      ['stream', { name: 'stdout', text: '\rstep 2' }],
      ['stream', { name: 'stderr', text: 'warn\n' }],
      ['stream', { name: 'stdout', text: 'end\n' }]
    ])
    expect(live.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'step 2' },
      { output_type: 'stream', name: 'stderr', text: 'warn\n' },
      { output_type: 'stream', name: 'stdout', text: 'end\n' }
    ])
  })

  it('maps results, displays and errors to nbformat outputs', () => {
    const live = apply([
      ['execute_result', { execution_count: 3, data: { 'text/plain': '42' }, metadata: {} }],
      ['display_data', { data: { 'image/png': 'AAAA' }, metadata: { 'image/png': {} } }],
      ['error', { ename: 'ValueError', evalue: 'bad', traceback: ['tb'] }]
    ])
    expect(live.outputs).toEqual([
      {
        output_type: 'execute_result',
        execution_count: 3,
        data: { 'text/plain': '42' },
        metadata: {}
      },
      { output_type: 'display_data', data: { 'image/png': 'AAAA' }, metadata: { 'image/png': {} } },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['tb'] }
    ])
  })

  it('clears at once, or on the next output when asked to wait', () => {
    const cleared = apply([
      ['stream', { name: 'stdout', text: 'old' }],
      ['clear_output', { wait: false }]
    ])
    expect(cleared.outputs).toEqual([])

    const waiting = apply([
      ['stream', { name: 'stdout', text: 'old' }],
      ['clear_output', { wait: true }]
    ])
    expect(waiting.outputs).toHaveLength(1)
    const replaced = applyKernelOutput(waiting, 'stream', { name: 'stdout', text: 'new' })
    expect(replaced).toEqual({
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'new' }],
      clearOnNextOutput: false
    })
  })

  it('updates a display in place by its display id, and stores it without the id', () => {
    const live = apply([
      [
        'display_data',
        { data: { 'text/plain': '0%' }, metadata: {}, transient: { display_id: 'p' } }
      ],
      ['display_data', { data: { 'text/plain': 'other' }, metadata: {} }],
      [
        'update_display_data',
        { data: { 'text/plain': '100%' }, metadata: {}, transient: { display_id: 'p' } }
      ]
    ])
    expect(toStoredOutputs(live.outputs)).toEqual([
      { output_type: 'display_data', data: { 'text/plain': '100%' }, metadata: {} },
      { output_type: 'display_data', data: { 'text/plain': 'other' }, metadata: {} }
    ])
  })
})
