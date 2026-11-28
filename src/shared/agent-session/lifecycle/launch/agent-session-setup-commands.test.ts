import { describe, expect, it } from 'vitest'
import { encodePowerShellCommand } from '../../../shell/launch/powershell-command-encoding'
import { agentSessionInstallCommand } from './agent-session-setup-commands'

const VIBE_WINDOWS_INSTALL =
  'irm https://astral.sh/uv/install.ps1 | iex; & "$env:USERPROFILE/.local/bin/uv.exe" tool install --python 3.12 mistral-vibe'

describe('agentSessionInstallCommand', () => {
  it('wraps a windowsInstallScript URL with irm | iex on win32', () => {
    expect(agentSessionInstallCommand('claude', 'win32')).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
    )
  })

  it('encodes a windowsInstallCommand so any Windows shell can run it', () => {
    expect(agentSessionInstallCommand('mistral-vibe', 'win32')).toBe(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(VIBE_WINDOWS_INSTALL)}`
    )
  })

  it('returns null on win32 when the agent has no Windows install action', () => {
    expect(agentSessionInstallCommand('kimi', 'win32')).toBeNull()
  })

  it('returns the POSIX install command on other platforms', () => {
    expect(agentSessionInstallCommand('mistral-vibe', 'darwin')).toBe(
      'curl -LsSf https://mistral.ai/vibe/install.sh | bash'
    )
  })
})
