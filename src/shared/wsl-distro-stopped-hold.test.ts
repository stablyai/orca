import { describe, expect, it } from 'vitest'
import {
  findWslDistroHoldInText,
  readableWslDistroHoldText,
  wslDistroHoldMessage,
  wslDistroHoldUserMessage
} from './wsl-distro-stopped-hold'

describe('a WSL hold named in text', () => {
  it.each(['stopped', 'unverifiable'] as const)(
    'finds a %s hold by its code or its sentence, with the exact text to swap',
    (state) => {
      const hold = { distro: 'Ubuntu-24.04', state }
      const code = wslDistroHoldMessage(hold.distro, state)
      const sentence = wslDistroHoldUserMessage(hold)

      expect(findWslDistroHoldInText(`Failed to start: ${code}`)).toEqual({
        hold,
        matched: code,
        form: 'code'
      })
      expect(findWslDistroHoldInText(`Failed to start: ${sentence} Also more.`)).toEqual({
        hold,
        matched: sentence,
        form: 'sentence'
      })
    }
  )

  it('finds nothing in unrelated text', () => {
    expect(findWslDistroHoldInText('spawn failed: ENOENT')).toBeNull()
    expect(findWslDistroHoldInText('The WSL distro is stopped')).toBeNull()
  })

  it('makes a code readable and leaves the rest of the text', () => {
    expect(
      readableWslDistroHoldText(
        'Failed to create the startup terminal for /wt: terminal_held_wsl_distro_unverifiable:Debian'
      )
    ).toBe(
      "Failed to create the startup terminal for /wt: Orca couldn't check whether the WSL distro Debian is running, so it didn't start this terminal. Start the distro, then try again."
    )
    expect(readableWslDistroHoldText('spawn failed')).toBe('spawn failed')
  })
})
