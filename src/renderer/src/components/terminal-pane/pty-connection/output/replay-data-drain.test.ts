import { expect, it } from 'vitest'
import { createTerminalStructuralReplayCoordinator } from '@/lib/pane-manager/terminal-replay/terminal-structural-replay-coordinator'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import {
  bindBeginReattachLiveDataDeferral,
  bindReattachLiveDataDeferral
} from './reattach-live-data-deferral'
import { bindReplayDataDrain } from './replay-data-drain'

it('retires queued replay when the pane is disposed before the replay starts', async () => {
  const coordinator = createTerminalStructuralReplayCoordinator({})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: disposal skips rendering, so only queue and deferral state is needed.
  const session = {
    transport: { getPtyId: () => 'pty-1' },
    transportStreamGeneration: 1,
    structuralReplayCoordinator: coordinator,
    replayWriteQueue: Promise.resolve(),
    reattachLiveDataDeferralDepth: 0,
    disposed: false
  } as unknown as ConnectPanePtySession
  bindBeginReattachLiveDataDeferral(session)
  bindReattachLiveDataDeferral(session)
  bindReplayDataDrain(session)
  session.pendingReplayData = { ptyId: 'pty-1', streamGeneration: 1, data: 'hello' }
  session.scheduleReplayDataDrain()
  const queued = session.replayWriteQueue
  session.disposed = true
  coordinator.dispose()

  try {
    await queued
    expect(session.replayWriteQueue).toBe(queued)
    expect(session.pendingReplayData).toBeNull()
    expect(session.reattachLiveDataDeferralDepth).toBe(0)
  } finally {
    // Bound cleanup even if a regression queues another drain.
    session.pendingReplayData = null
    await session.replayWriteQueue
  }
})
