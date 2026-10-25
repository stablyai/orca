import { describe, expect, it } from 'vitest'
import { buildWindowsCmdRunnerDelayedLaunchCommand } from './windows-cmd-runner-delayed-launch'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  if (!encoded) {
    throw new Error(`no -EncodedCommand payload in: ${command}`)
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('buildWindowsCmdRunnerDelayedLaunchCommand', () => {
  it('spells no -ExecutionPolicy switch', () => {
    const command = buildWindowsCmdRunnerDelayedLaunchCommand('C:\\work\\setup.cmd')
    const switches = command.replace(/ -EncodedCommand \S+$/, '')

    // EncodedCommand is not policy-gated (only File is); Bypass adds an EDR signal without changing execution.
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/Bypass/i)
    expect(switches).toBe('powershell.exe -NoProfile -NonInteractive')
  })

  it('keeps the base64 that shields the runner path from the pane shell', () => {
    // This command is typed into a pane shell; base64 must protect cmd metacharacters in its path.
    const command = buildWindowsCmdRunnerDelayedLaunchCommand('C:\\work (x86)\\se&tup.cmd')

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    const script = decodePayload(command)
    expect(script).toContain("$runner = 'C:\\work (x86)\\se&tup.cmd'")
    expect(script).toContain('/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""')
  })

  it('doubles typographic single quotes in the runner path literal', () => {
    const script = decodePayload(
      buildWindowsCmdRunnerDelayedLaunchCommand('C:\\O\u2019Brien\\setup.cmd')
    )
    expect(script).toContain("$runner = 'C:\\O\u2019\u2019Brien\\setup.cmd'")
  })
})
