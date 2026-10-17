import { describe, expect, it } from 'vitest'
import {
  buildConsoleView,
  EMPTY_CONSOLE_HISTORY,
  pushConsoleHistory,
  stepConsoleHistory,
  stripAnsi
} from './debug-console-model'

const out = (seq: number, text: string, category = 'stdout') => ({ seq, ts: seq, category, text })

describe('stripAnsi', () => {
  it('removes SGR, cursor, OSC and two-byte escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b[2Kline')).toBe('red line')
    expect(stripAnsi('\u001b]0;title\u0007after')).toBe('after')
    expect(stripAnsi('\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\')).toBe('link')
    expect(stripAnsi('a\u001bMb')).toBe('ab')
  })
})

describe('buildConsoleView', () => {
  it('splits lines, keeps categories and strips escapes', () => {
    const view = buildConsoleView(
      [out(1, 'one\ntwo\n'), out(2, '\u001b[31mboom\u001b[0m\n', 'stderr')],
      []
    )
    expect(view.map((line) => [line.category, line.text])).toEqual([
      ['stdout', 'one'],
      ['stdout', 'two'],
      ['stderr', 'boom']
    ])
  })

  it('drops telemetry and interleaves local lines after the output they followed', () => {
    const view = buildConsoleView(
      [out(1, 'a'), out(2, 'secret', 'telemetry'), out(3, 'c')],
      [{ afterSeq: 1, order: 1, category: 'input', text: '> x' }]
    )
    expect(view.map((line) => line.text)).toEqual(['a', '> x', 'c'])
  })

  it('caps to the newest lines', () => {
    const output = Array.from({ length: 10 }, (_, i) => out(i + 1, `l${i + 1}`))
    expect(buildConsoleView(output, [], 3).map((line) => line.text)).toEqual(['l8', 'l9', 'l10'])
  })
})

describe('console history', () => {
  it('walks back with Up, forward with Down and restores the draft', () => {
    let history = pushConsoleHistory(pushConsoleHistory(EMPTY_CONSOLE_HISTORY, 'a'), 'b')
    let step = stepConsoleHistory(history, -1, 'draft')
    expect(step.value).toBe('b')
    history = step.history
    step = stepConsoleHistory(history, -1, step.value)
    expect(step.value).toBe('a')
    step = stepConsoleHistory(step.history, -1, step.value)
    expect(step.value).toBe('a')
    step = stepConsoleHistory(step.history, 1, step.value)
    expect(step.value).toBe('b')
    step = stepConsoleHistory(step.history, 1, step.value)
    expect(step.value).toBe('draft')
    expect(step.history.index).toBeNull()
  })

  it('does not repeat the same consecutive entry', () => {
    const history = pushConsoleHistory(pushConsoleHistory(EMPTY_CONSOLE_HISTORY, 'a'), 'a')
    expect(history.entries).toEqual(['a'])
  })
})
