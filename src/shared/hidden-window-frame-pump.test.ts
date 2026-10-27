import { describe, expect, it } from 'vitest'
import {
  formatHiddenWindowFramePumpArgument,
  hasHiddenWindowFramePumpArgument,
  shouldPumpHiddenWindowFrames
} from './hidden-window-frame-pump'

describe('shouldPumpHiddenWindowFrames', () => {
  it('pumps only a Windows background launch', () => {
    expect(shouldPumpHiddenWindowFrames({ ORCA_BACKGROUND_LAUNCH: '1' }, 'win32')).toBe(true)
    expect(shouldPumpHiddenWindowFrames({ ORCA_BACKGROUND_LAUNCH: '1' }, 'darwin')).toBe(false)
    expect(shouldPumpHiddenWindowFrames({ ORCA_BACKGROUND_LAUNCH: '1' }, 'linux')).toBe(false)
    expect(shouldPumpHiddenWindowFrames({}, 'win32')).toBe(false)
    expect(shouldPumpHiddenWindowFrames({ ORCA_BACKGROUND_LAUNCH: '0' }, 'win32')).toBe(false)
  })

  it('reads back only the argument main stamped', () => {
    expect(hasHiddenWindowFramePumpArgument(['--x', formatHiddenWindowFramePumpArgument()])).toBe(
      true
    )
    expect(hasHiddenWindowFramePumpArgument(['--orca-browser-client-host-id=abc'])).toBe(false)
  })
})
