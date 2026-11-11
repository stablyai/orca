import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureWakeScrollback,
  HOLD_RENDER_UNTIL_RESTORED,
  resetWakeScrollbackForTests
} from '@/lib/orca-cloud/cloud-wake-scrollback'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { bindFreshSpawnFollowReset } from './fresh-spawn-follow-reset'

afterEach(() => resetWakeScrollbackForTests())

function session(leafId: string): { session: ConnectPanePtySession; writes: string[] } {
  const writes: string[] = []
  const stub = {
    pane: { id: 1, leafId, terminal: { rows: 4 } },
    deps: { restoredViewportBlankingPanesRef: { current: new Set<number>() } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stub with only the fields the binder's viewport-prepare path reads; writeReplayData is replaced below.
  const typed = stub as unknown as ConnectPanePtySession
  bindFreshSpawnFollowReset(typed)
  typed.writeReplayData = vi.fn((data: string) => {
    writes.push(data)
  })
  return { session: typed, writes }
}

describe('fresh-spawn viewport blanking on a woken cloud pane (WAKE-SCROLLBACK)', () => {
  it('a pane with pre-sleep output to put back is held, not blanked (no blank frame before the restore)', async () => {
    const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    await new Promise<void>((resolve) => terminal.write('$ seq 1 3\r\n1\r\n2\r\n3\r\n$ ', resolve))
    captureWakeScrollback('leaf-1', terminal, { sleptAt: 1, agentPane: false, maxRows: 5000 })
    const { session: s, writes } = session('leaf-1')
    s.prepareFreshShellViewportForSpawn({ forceBlankRestoredViewport: true })
    expect(writes).toEqual([HOLD_RENDER_UNTIL_RESTORED])
  })

  it('any other pane is blanked as before', () => {
    const { session: s, writes } = session('leaf-2')
    s.prepareFreshShellViewportForSpawn({ forceBlankRestoredViewport: true })
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toBe(HOLD_RENDER_UNTIL_RESTORED)
    expect(writes[0]).toContain('\x1b[H')
  })
})
