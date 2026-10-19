import { describe, expect, it } from 'vitest'
import {
  hasExplicitOzonePlatform,
  headlessServeOzonePlatformSwitches
} from './headless-serve-ozone-platform'

describe('headless serve Ozone platform switches', () => {
  it('pins X11 only for Linux serve launches', () => {
    expect(headlessServeOzonePlatformSwitches('linux')).toEqual(['--ozone-platform=x11'])
    expect(headlessServeOzonePlatformSwitches('darwin')).toEqual([])
    expect(headlessServeOzonePlatformSwitches('win32')).toEqual([])
  })

  it.each([
    { argv: ['--ozone-platform=wayland'], explicit: true },
    { argv: ['--ozone-platform', 'x11'], explicit: true },
    { argv: ['--ozone-platform-hint=auto'], explicit: false },
    { argv: ['--', '--ozone-platform=x11'], explicit: false },
    { argv: ['--serve'], explicit: false }
  ])('reads $argv as explicit=$explicit', ({ argv, explicit }) => {
    expect(hasExplicitOzonePlatform(argv)).toBe(explicit)
  })
})
