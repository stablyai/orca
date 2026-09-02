import { describe, expect, it } from 'vitest'
import { CLI_GLOBAL_VALUE_FLAGS, findCliCommandIndex } from './cli-argument-boundary'

const COMMAND_PATHS = [['project'], ['serve'], ['status'], ['worktree']] as const

describe('findCliCommandIndex', () => {
  it.each([
    { argv: ['--json', 'status'], expected: 1, name: 'global boolean' },
    { argv: ['--environment', 'status'], expected: 1, name: 'missing global value' },
    {
      argv: ['--environment', 'status', 'worktree', 'list'],
      expected: 2,
      name: 'command-named value'
    },
    {
      argv: ['--project', 'github:stablyai/orca', 'project', 'setups'],
      expected: 2,
      name: 'selector value'
    },
    { argv: ['--project=github:stablyai/orca', 'project'], expected: 1, name: 'assignment' },
    { argv: ['--', 'status'], expected: 1, name: 'bare double dash' },
    { argv: ['workspace', 'status'], expected: -1, name: 'first non-command positional' },
    { argv: ['serve'], expected: 0, name: 'direct serve' }
  ])('$name', ({ argv, expected }) => {
    expect(findCliCommandIndex(argv, COMMAND_PATHS)).toBe(expected)
  })

  it('consumes known global values at the launch boundary', () => {
    expect(
      findCliCommandIndex(['--environment', 'status'], COMMAND_PATHS, CLI_GLOBAL_VALUE_FLAGS)
    ).toBe(-1)
  })
})
