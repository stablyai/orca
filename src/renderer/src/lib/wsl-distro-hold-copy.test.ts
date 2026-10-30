import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, _fallback: string, values: { distro: string }) =>
    `[${key}] ${values.distro}`
}))

const { localizeWslDistroHoldText } = await import('./wsl-distro-hold-copy')

describe('localizeWslDistroHoldText', () => {
  it("swaps an older host's code for the user's language, naming the distro", () => {
    expect(
      localizeWslDistroHoldText(
        'Failed to create the startup terminal for /wt: terminal_held_wsl_distro_stopped:Ubuntu'
      )
    ).toBe('Failed to create the startup terminal for /wt: [wslDistroHold.terminalStopped] Ubuntu')
  })

  it("swaps a newer host's English sentence the same way", () => {
    expect(
      localizeWslDistroHoldText(
        "Orca couldn't check whether the WSL distro Debian is running, so it didn't start this terminal. Start the distro, then try again."
      )
    ).toBe('[wslDistroHold.terminalUnverifiable] Debian')
  })

  it('swaps every mention of the same hold in a combined warning', () => {
    const code = 'terminal_held_wsl_distro_stopped:Ubuntu'
    expect(localizeWslDistroHoldText(`A: ${code} Also B: ${code}`)).toBe(
      'A: [wslDistroHold.terminalStopped] Ubuntu Also B: [wslDistroHold.terminalStopped] Ubuntu'
    )
  })

  it('leaves other messages alone', () => {
    expect(localizeWslDistroHoldText('Remote terminal was closed.')).toBe(
      'Remote terminal was closed.'
    )
  })
})
