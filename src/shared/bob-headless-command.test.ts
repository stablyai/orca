import { describe, expect, it } from 'vitest'
import { isBobHeadlessOneShotCommand } from './bob-headless-command'

describe('isBobHeadlessOneShotCommand', () => {
  it('classifies Bob Shell 2.x subcommands', () => {
    expect(isBobHeadlessOneShotCommand(['bob', 'chat', '--trust'])).toBe(false)
    expect(isBobHeadlessOneShotCommand(['bob'])).toBe(false)
    expect(isBobHeadlessOneShotCommand(['bob', '-r', 'abc'])).toBe(false)
    expect(isBobHeadlessOneShotCommand(['bob', 'run', 'review'])).toBe(true)
    expect(isBobHeadlessOneShotCommand(['bob', '-p', 'review'])).toBe(true)
    expect(isBobHeadlessOneShotCommand(['bob', 'mcp', 'list'])).toBe(true)
  })

  it('locates the bobshell package script but not an unrelated bob.js', () => {
    expect(
      isBobHeadlessOneShotCommand([
        'node',
        '/Users/dev/.nvm/versions/node/v26.5.1/lib/node_modules/bobshell/dist/bob.js',
        'chat'
      ])
    ).toBe(false)
    // Why: an unrelated script is not an executable token, so `chat` is never read as Bob's subcommand.
    expect(isBobHeadlessOneShotCommand(['node', '/repo/bob.js', 'chat'])).toBe(true)
    expect(
      isBobHeadlessOneShotCommand(['node', '/repo/fake-node_modules/bobshell/dist/bob.js', 'chat'])
    ).toBe(true)
    expect(isBobHeadlessOneShotCommand(['node', 'node_modules/bobshell/dist/bob.js', 'chat'])).toBe(
      false
    )
  })
})
