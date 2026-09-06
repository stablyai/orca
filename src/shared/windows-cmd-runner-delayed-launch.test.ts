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

    // Why: `-EncodedCommand` is not execution-policy gated — only `-File` is — so the switch
    // was a no-op next to a heavily EDR-flagged base64 command line.
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/Bypass/i)
    expect(switches).toBe('powershell.exe -NoProfile -NonInteractive')
  })

  it('keeps the base64 that shields the runner path from the pane shell', () => {
    // Why: this whole module exists because the path carries cmd metacharacters; the
    // command is typed into a terminal pane, so the base64 must stay.
    const command = buildWindowsCmdRunnerDelayedLaunchCommand('C:\\work (x86)\\se&tup.cmd')

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    const script = decodePayload(command)
    expect(script).toContain("$runner = 'C:\\work (x86)\\se&tup.cmd'")
    expect(script).toContain('/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""')
  })
})
