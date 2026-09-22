import { describe, expect, it } from 'vitest'
import { isOpenCode2LaunchCommand } from './opencode-launch-command'

describe('isOpenCode2LaunchCommand', () => {
  it.each(['opencode2', '/usr/local/bin/opencode2', 'opencode2.exe', 'opencode2.cmd'])(
    'recognizes %s',
    (command) => {
      expect(isOpenCode2LaunchCommand(command)).toBe(true)
    }
  )

  it.each(['opencode', 'echo opencode2', 'opencode2-helper'])('rejects %s', (command) => {
    expect(isOpenCode2LaunchCommand(command)).toBe(false)
  })
})
