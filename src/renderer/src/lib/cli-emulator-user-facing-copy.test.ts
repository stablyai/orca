import { describe, expect, it } from 'vitest'
import { formatCliUserFacingDetail } from './cli-emulator-user-facing-copy'

describe('formatCliUserFacingDetail', () => {
  it('localizes WSL timeouts wrapped in Electron invoke errors', () => {
    expect(
      formatCliUserFacingDetail(
        "Error invoking remote method 'cli:getWslInstallStatus': Error: WSL command timed out after 10000ms."
      )
    ).toBe('WSL command timed out after 10000ms.')
  })

  it('localizes Windows shell registration details including a blank path', () => {
    expect(
      formatCliUserFacingDetail(
        'Register C:\\Orca\\resources\\bin\\orca.exe to use Orca from Command Prompt or PowerShell.'
      )
    ).toBe(
      'Register C:\\Orca\\resources\\bin\\orca.exe to use Orca from Command Prompt or PowerShell.'
    )
    expect(
      formatCliUserFacingDetail('Register  to use Orca from Command Prompt or PowerShell.')
    ).toBe('Register orca to use Orca from Command Prompt or PowerShell.')
  })

  it('localizes WSL registration details including a blank path', () => {
    expect(formatCliUserFacingDetail('Register ~/.local/bin/orca-ide to use Orca from WSL.')).toBe(
      'Register ~/.local/bin/orca-ide to use Orca from WSL.'
    )
    expect(formatCliUserFacingDetail('Register  to use Orca from WSL.')).toBe(
      'Register orca to use Orca from WSL.'
    )
  })
})
