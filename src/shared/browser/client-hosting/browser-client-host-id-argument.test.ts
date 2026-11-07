import { describe, expect, it } from 'vitest'
import {
  formatBrowserClientHostIdArgument,
  readBrowserClientHostIdArgument
} from './browser-client-host-id-argument'

const HOST_ID = '6f0f6b1c-6c8e-4a5f-9a6b-8d3f2b1c4e5a'
const OTHER_HOST_ID = '0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f'

describe('browser client host id argument', () => {
  // Keep the stamp before Electron's trailing --seatbelt-client and add a prefix-containing decoy; tail-only/substring readers otherwise pass fixtures but fail real macOS renderers.
  it('reads back the id it formatted, from the middle of a real argv', () => {
    const argv = [
      '/Applications/Orca.app/Contents/MacOS/Orca',
      '--type=renderer',
      `--wrapped-flag=${formatBrowserClientHostIdArgument('decoy')}`,
      '--enable-sandbox',
      formatBrowserClientHostIdArgument(HOST_ID),
      '--seatbelt-client=50'
    ]

    expect(readBrowserClientHostIdArgument(argv)).toBe(HOST_ID)
  })

  // First stamp wins because it is the app's; pin behavior if another appears later.
  it('takes the first stamp when argv carries two', () => {
    const argv = [
      '--type=renderer',
      formatBrowserClientHostIdArgument(HOST_ID),
      formatBrowserClientHostIdArgument(OTHER_HOST_ID),
      '--seatbelt-client=50'
    ]

    expect(readBrowserClientHostIdArgument(argv)).toBe(HOST_ID)
  })

  // Empty IDs must return null or the renderer cache would latch an unusable answer.
  it.each([
    ['an argv with no such argument', ['--type=renderer', '--enable-sandbox']],
    ['an empty argv', []],
    ['a flag whose value is empty', ['--orca-browser-client-host-id=']],
    ['a different flag that starts the same way', ['--orca-browser-client-host-idle=1']]
  ])('reports no id for %s', (_label, argv) => {
    expect(readBrowserClientHostIdArgument(argv)).toBeNull()
  })

  // Pin the shared main/preload literal; one-sided renames look like a non-hosting client.
  it('formats the argument main and the preload have to agree on', () => {
    expect(formatBrowserClientHostIdArgument(HOST_ID)).toBe(
      `--orca-browser-client-host-id=${HOST_ID}`
    )
  })
})
