import { describe, expect, it } from 'vitest'
import { isDsbHeadlessOneShotCommand } from './dsb-headless-command'

describe('DeepSeek Build headless one-shot commands', () => {
  it.each([
    ['-r', './preload.js'],
    ['--require', './preload.js'],
    ['--import', './preload.mjs'],
    ['--loader', './loader.mjs'],
    ['--experimental-loader', './loader.mjs'],
    ['--require=./preload.js'],
    ['--import=./preload.mjs']
  ])('finds run after Node options %j', (...options) => {
    const shim = '/usr/lib/node_modules/@innocarpe/deepseek-build/npm/bin/dsb.js'
    expect(isDsbHeadlessOneShotCommand(['node', ...options, shim, 'run', 'task'])).toBe(true)
    expect(isDsbHeadlessOneShotCommand(['node', ...options, shim, 'agent'])).toBe(false)
  })

  it.each(['/usr/local/bin/node', 'C:\\Program Files\\nodejs\\node.exe'])(
    'recognizes the interpreter path %s before preload arguments',
    (node) => {
      const shim = 'C:\\Users\\dev\\node_modules\\@innocarpe\\deepseek-build\\npm\\bin\\dsb.js'
      expect(isDsbHeadlessOneShotCommand([node, '-r', './preload.js', shim, 'run', 'task'])).toBe(
        true
      )
    }
  )

  it.each(['--cwd', '--preset', '--base-url', '--session', '--worktree-ref', '--effort'])(
    'finds run after the upstream value option %s',
    (option) => {
      expect(isDsbHeadlessOneShotCommand(['dsb', option, 'value', 'run', 'task'])).toBe(true)
      expect(isDsbHeadlessOneShotCommand(['dsb', `${option}=value`, 'run', 'task'])).toBe(true)
      expect(isDsbHeadlessOneShotCommand(['dsb', option, 'run', 'agent'])).toBe(false)
    }
  )

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
