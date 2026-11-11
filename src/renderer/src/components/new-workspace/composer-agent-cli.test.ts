import { describe, expect, it } from 'vitest'
import { composerAgentSelection } from './composer-agent-cli'

describe('composerAgentSelection (PC-9)', () => {
  it('Orca Cloud: the one Claude never reads "(CLI)"', () => {
    expect(composerAgentSelection({ cli: true, ready: true }, true)).toEqual({
      cli: false,
      ready: true
    })
  })

  it('this computer with a chat surface keeps "(CLI)" on the terminal pick', () => {
    const local = { cli: true, ready: true }
    expect(composerAgentSelection(local, false)).toBe(local)
  })
})
