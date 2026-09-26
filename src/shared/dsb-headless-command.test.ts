import { describe, expect, it } from 'vitest'
import { isDsbHeadlessOneShotCommand } from './dsb-headless-command'

describe('DeepSeek Build launch shape', () => {
  it('treats run as a one-shot and leaves the TUI interactive', () => {
    expect(isDsbHeadlessOneShotCommand(['dsb', 'run', 'explain this'])).toBe(true)
    expect(isDsbHeadlessOneShotCommand(['dsb', '--dogfood'])).toBe(false)
    expect(isDsbHeadlessOneShotCommand(['dsb', 'agent'])).toBe(false)
    expect(isDsbHeadlessOneShotCommand(['dsb', '--resume', 'sess-1'])).toBe(false)
    expect(
      isDsbHeadlessOneShotCommand([
        'node',
        '/usr/lib/node_modules/@innocarpe/deepseek-build/npm/bin/dsb.js',
        'run',
        'explain this'
      ])
    ).toBe(true)
    expect(
      isDsbHeadlessOneShotCommand([
        'node',
        '/usr/lib/node_modules/@innocarpe/deepseek-build/npm/bin/dsb.js',
        '--dogfood'
      ])
    ).toBe(false)
  })
})
