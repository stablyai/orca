import { describe, expect, it } from 'vitest'
import {
  buildFreshShellProbeInputSequence,
  buildSettledShellProbeInputSequence
} from './terminal-probe-input-sequence'

const command = "& 'C:\\node\\node.exe' '-e' 'console.log(1)'\r"

describe('buildFreshShellProbeInputSequence', () => {
  it('does not prefix fresh shell probes with interrupt or line-kill bytes', () => {
    expect(buildFreshShellProbeInputSequence(command)).toEqual([command])
    expect(buildFreshShellProbeInputSequence(command).join('')).not.toContain('\x03')
    expect(buildFreshShellProbeInputSequence(command).join('')).not.toContain('\x15')
  })
})

describe('buildSettledShellProbeInputSequence', () => {
  it('resets PowerShell without sending the POSIX Ctrl+U binding', () => {
    expect(buildSettledShellProbeInputSequence(command, 'win32')).toEqual(['\x03', command])
    expect(buildSettledShellProbeInputSequence(command, 'win32').join('')).not.toContain('\x15')
  })

  it.each(['linux', 'darwin'] as const)('preserves the POSIX reset on %s', (platform) => {
    expect(buildSettledShellProbeInputSequence(command, platform)).toEqual(['\x03\x15', command])
  })
})
