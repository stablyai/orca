import { describe, expect, it } from 'vitest'
import {
  formatBrowserClientHostIdArgument,
  readBrowserClientHostIdArgument
} from './browser-client-host-id-argument'

const HOST_ID = '6f0f6b1c-6c8e-4a5f-9a6b-8d3f2b1c4e5a'
const OTHER_HOST_ID = '0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f'

describe('browser client host id argument', () => {
  // Why the stamp is not last and why a decoy sits ahead of it: a real macOS renderer's argv runs
  // on past our argument — Electron appends --seatbelt-client after it — so a fixture that ends on
  // the stamp passes a reader that only looks at the tail and fails on every real renderer. The
  // decoy is an argument that merely contains the prefix; matching on containment would slice the
  // id out of the middle of someone else's flag.
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

  // Why a tie-break is pinned when main stamps exactly one: it is what decides the answer if
  // anything ever appends a second stamp, and only the first one is the one this app placed.
  it('takes the first stamp when argv carries two', () => {
    const argv = [
      '--type=renderer',
      formatBrowserClientHostIdArgument(HOST_ID),
      formatBrowserClientHostIdArgument(OTHER_HOST_ID),
      '--seatbelt-client=50'
    ]

    expect(readBrowserClientHostIdArgument(argv)).toBe(HOST_ID)
  })

  // Why an empty value is null and not '': an empty host id would compare equal to nothing a
  // placement can carry, but it would still latch the renderer's cache as an answer.
  it.each([
    ['an argv with no such argument', ['--type=renderer', '--enable-sandbox']],
    ['an empty argv', []],
    ['a flag whose value is empty', ['--orca-browser-client-host-id=']],
    ['a different flag that starts the same way', ['--orca-browser-client-host-idle=1']]
  ])('reports no id for %s', (_label, argv) => {
    expect(readBrowserClientHostIdArgument(argv)).toBeNull()
  })

  // Why the prefix is pinned as a literal: main stamps it and the preload parses it, and a rename
  // on one side alone reads exactly like a client that hosts nothing.
  it('formats the argument main and the preload have to agree on', () => {
    expect(formatBrowserClientHostIdArgument(HOST_ID)).toBe(
      `--orca-browser-client-host-id=${HOST_ID}`
    )
  })
})
