// Layout-owner restore acks name the pane so main releases saved output only for its current terminal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ackColdRestore = vi.fn()
const session = {
  deps: { worktreeId: 'repo::/wt', tabId: 'tab-1' },
  pane: { leafId: 'leaf-1' }
}

async function ackWithSwitch(on: boolean, ptyId: string): Promise<void> {
  vi.resetModules()
  vi.doMock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: on }))
  const { ackPaintedColdRestore } = await import('./painted-cold-restore-ack')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ack reads only the session members this fixture supplies.
  ackPaintedColdRestore(session as never, ptyId)
}

describe('ackPaintedColdRestore', () => {
  beforeEach(() => {
    ackColdRestore.mockClear()
    vi.stubGlobal('window', { api: { pty: { ackColdRestore } } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('acks by terminal only with the switch off', async () => {
    await ackWithSwitch(false, 'pty-1')
    expect(ackColdRestore).toHaveBeenCalledWith('pty-1')
  })

  it('names the painted pane in the layout-owner build', async () => {
    await ackWithSwitch(true, 'pty-1')
    expect(ackColdRestore).toHaveBeenCalledWith('pty-1', {
      worktreeId: 'repo::/wt',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
  })

  it('never acks a paired server’s terminal, whose host owns its restore', async () => {
    const { toRemoteRuntimePtyId } =
      await import('../../../../../shared/remote-runtime/remote-runtime-pty-id')
    await ackWithSwitch(true, toRemoteRuntimePtyId('handle-1', 'env-1'))
    expect(ackColdRestore).not.toHaveBeenCalled()
  })
})
