import { describe, expect, it } from 'vitest'
import { buildFreshShellProbeInputSequence } from './terminal-probe-input-sequence'

describe('buildFreshShellProbeInputSequence', () => {
  it('does not prefix fresh shell probes with interrupt or line-kill bytes', () => {
    const command = "& 'C:\\node\\node.exe' '-e' 'console.log(1)'\r"

    expect(buildFreshShellProbeInputSequence(command)).toEqual([command])
    expect(buildFreshShellProbeInputSequence(command).join('')).not.toContain('\x03')
    expect(buildFreshShellProbeInputSequence(command).join('')).not.toContain('\x15')
  })
})
