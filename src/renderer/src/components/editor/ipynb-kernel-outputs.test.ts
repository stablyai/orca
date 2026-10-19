import { describe, expect, it, vi } from 'vitest'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import {
  applyKernelOutput,
  collapseCarriageReturns,
  toStoredOutputs,
  type LiveOutputs
} from './ipynb-kernel-outputs'

const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }

// Frozen pre-fix stream reducer: the parity oracle must not share the incremental implementation.
function originalStreamOutput(
  live: LiveOutputs,
  type: 'stream' | 'clear_output',
  content: Record<string, unknown>
): LiveOutputs {
  if (type === 'clear_output') {
    return content.wait
      ? { ...live, clearOnNextOutput: true }
      : { ...live, outputs: [], clearOnNextOutput: false }
  }
  const normalize = (text: string): string =>
    text.replace(/\r+\n/g, '\n').replace(/^[^\n]*\r(?=[^\n])/gm, '')
  const outputs = live.clearOnNextOutput ? [] : live.outputs
  const last = outputs.at(-1)
  const output =
    last?.output_type === 'stream' && last.name === content.name
      ? { ...last, text: normalize(`${String(last.text)}${String(content.text ?? '')}`) }
      : {
          output_type: type,
          name: content.name ?? 'stdout',
          text: normalize(String(content.text ?? ''))
        }
  return {
    ...live,
    outputs: [
      ...(last?.output_type === 'stream' && last.name === content.name
        ? outputs.slice(0, -1)
        : outputs),
      output
    ],
    clearOnNextOutput: false
  }
}

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
  it('does not normalize accumulated LF-only or LF-free text again on append', () => {
    for (const chunk of ['log entry\n'.repeat(400), 'x'.repeat(4320)]) {
      let live = EMPTY
      const replace = vi.spyOn(String.prototype, 'replace')
      let normalizeCalls: number
      try {
        for (let frame = 0; frame < 512; frame += 1) {
          live = applyKernelOutput(live, 'stream', { name: 'stdout', text: chunk })
        }
        normalizeCalls = replace.mock.calls.length
      } finally {
        replace.mockRestore()
      }
      expect(normalizeCalls).toBe(2)
      expect(live.outputs).toEqual([
        { output_type: 'stream', name: 'stdout', text: chunk.repeat(512) }
      ])
    }
  })

  it('matches the original reducer across randomized stream names, clears, and control boundaries', () => {
    let seed = 0x51a7cafe
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const characters = ['x', ' ', '\r', '\n', '\u2028', '\u2029', '\ud83d', '\ude80']
    for (let scenario = 0; scenario < 30; scenario += 1) {
      let original = EMPTY
      let incremental = EMPTY
      for (let frame = 0; frame < 300; frame += 1) {
        const clear = next() % 17 === 0
        let text = ''
        const length = next() % 32
        for (let index = 0; index < length; index += 1) {
          text += characters[next() % characters.length]
        }
        const content = clear
          ? { wait: next() % 2 === 0 }
          : { name: next() % 3 === 0 ? undefined : next() % 2 === 0 ? 'stdout' : 'stderr', text }
        const type = clear ? 'clear_output' : 'stream'
        original = originalStreamOutput(original, type, content)
        incremental = applyKernelOutput(incremental, type, content)
        expect(incremental).toEqual(original)
      }
    }
  })

  it('preserves a completed prefix when progress rewrites and CRLF split between frames', () => {
    const prefix = 'completed line\n'.repeat(10_000)
    const chunks = [`${prefix}0%`, '\r', '1%', '\r\r', '\nnext', '\r100%', '\r', '', '\n']
    let original = EMPTY
    let incremental = EMPTY
    for (const text of chunks) {
      const content = { name: 'stdout', text }
      original = originalStreamOutput(original, 'stream', content)
      incremental = applyKernelOutput(incremental, 'stream', content)
      expect(incremental).toEqual(original)
    }
    expect(incremental.outputs[0]?.text).toBe(`${prefix}\n100%\n`)
  })

  it('normalizes reconstructed and externally changed output text using the original semantics', () => {
    const reconstructed: LiveOutputs = {
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['old\r', 'value\n'], metadata: 1 }],
      clearOnNextOutput: false
    }
    const content = { name: 'stdout', text: '\rnew' }
    expect(applyKernelOutput(reconstructed, 'stream', content)).toEqual(
      originalStreamOutput(reconstructed, 'stream', content)
    )
    const changed = applyKernelOutput(EMPTY, 'stream', { name: 'stdout', text: 'initial\n' })
    const output = changed.outputs[0]
    if (!output) {
      throw new Error('Missing stream output')
    }
    output.text = 'prefix\rchanged'
    expect(applyKernelOutput(changed, 'stream', content)).toEqual(
      originalStreamOutput(changed, 'stream', content)
    )
  })

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
