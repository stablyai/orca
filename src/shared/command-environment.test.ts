import { describe, expect, it } from 'vitest'
import { extractLeadingEnvAssignments, mergeCommandEnvironment } from './command-environment'

describe('command environment assignments', () => {
  it('lets the last assignment override every Windows spelling without mutating the base', () => {
    const base = { PATH: 'old', Path: 'also old', TOKEN: 'old', KEEP: 'keep', ComSpec: 'cmd.exe' }
    const { env } = extractLeadingEnvAssignments([
      'Path=first',
      'PATH=second',
      'Path=last',
      'token=',
      'agent'
    ])
    expect(mergeCommandEnvironment(base, env, 'win32')).toEqual({
      PATH: 'last',
      TOKEN: '',
      KEEP: 'keep',
      COMSPEC: 'cmd.exe'
    })
    expect(base.PATH).toBe('old')
    expect(mergeCommandEnvironment({ PATH: 'old' }, { Path: 'new' }, 'linux')).toEqual({
      PATH: 'old',
      Path: 'new'
    })
    expect(mergeCommandEnvironment(undefined, undefined, 'darwin')).toBeUndefined()
  })
})
