import {
  lastAlternateScreenTransition,
  sshReconnectPaintsFromModel
} from '../ssh-reattach-model-restore'
import { shouldSkipAltFrameForWidthMismatch } from '../terminal-snapshot-replay-paint'

import type { PtyBufferSnapshot } from '../pty-transport'

type SshReconnectModelPaint = {
  altFrameWouldBeSkipped: boolean
  paintsFromModel: boolean
  snapshot: PtyBufferSnapshot | null
}

export async function resolveSshReconnectModelPaint(args: {
  reconnectMayUseModel: boolean
  replay: string | undefined
  fetchSnapshot: () => Promise<PtyBufferSnapshot | null>
  readTargetCols: () => number | undefined
}): Promise<SshReconnectModelPaint> {
  if (!args.reconnectMayUseModel) {
    return { altFrameWouldBeSkipped: false, paintsFromModel: false, snapshot: null }
  }
  // Decide before the probe: an exit makes the snapshot unusable, so waiting only delays replay.
  const replayTransition = lastAlternateScreenTransition(args.replay)
  if (replayTransition === 'exited') {
    return { altFrameWouldBeSkipped: false, paintsFromModel: false, snapshot: null }
  }
  const snapshot = await args.fetchSnapshot()
  const altFrameWouldBeSkipped = snapshot
    ? shouldSkipAltFrameForWidthMismatch(snapshot.cols, args.readTargetCols())
    : false
  return {
    altFrameWouldBeSkipped,
    paintsFromModel: sshReconnectPaintsFromModel({
      snapshot,
      hasReplay: Boolean(args.replay),
      replayTransition,
      altFrameWouldBeSkipped
    }),
    snapshot
  }
}
