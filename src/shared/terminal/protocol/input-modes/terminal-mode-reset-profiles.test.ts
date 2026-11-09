import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { PROCESS_BOUNDARY_GROUND, buildKittyKeyboardRestore } from './terminal-mode-reset-profiles'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'

// Consumers import these bytes; literal expectations catch modes silently disappearing.
describe('terminal mode reset profiles', () => {
  it("clears a dead TUI's alternate-screen kitty flags for the next alternate-screen app", async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    await write(`\x1b[?1049h\x1b[>7u\x1b[>1u${PROCESS_BOUNDARY_GROUND}\x1b[?1049h`)
    // Query, then pop once and query again: an empty stack pops to 0.
    await write('\x1b[?u\x1b[<1u\x1b[?u')
    expect(replies).toEqual(['\x1b[?0u', '\x1b[?0u'])
    term.dispose()
  })

  // A replayed push grows xterm’s stack but acts as a mirror set; pop-all prevents the app’s single pop restoring stale flags.
  it("brings xterm and the mirror to 0 on the app's pop after a redelivered push", async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const mirror = new TerminalKittyKeyboardModeTracker()
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    const xtermFlags = async (): Promise<string> => {
      replies.length = 0
      await write('\x1b[?u')
      return replies.join('')
    }
    for (const redelivery of ['\x1b[>1u', '\x1b[>1u']) {
      mirror.scanReplay(redelivery)
      await write(redelivery)
    }
    const restore = buildKittyKeyboardRestore(mirror.snapshotFlags)
    mirror.scan(restore)
    await write(restore)
    expect(mirror.flags).toBe(1)
    expect(await xtermFlags()).toBe('\x1b[?1u')

    mirror.scan('\x1b[<u')
    await write('\x1b[<u')
    expect(mirror.flags).toBe(0)
    expect(await xtermFlags()).toBe('\x1b[?0u')
    term.dispose()
  })
})
