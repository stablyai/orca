import type { Terminal } from '@xterm/xterm'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'

type InitialRenderPaneManager = {
  getPanes(): { terminal: Terminal }[]
}

export function scheduleTerminalInitialRenderSettled(args: {
  manager: InitialRenderPaneManager
  isCurrent: () => boolean
  isReplaySettled: () => boolean
  isContentReady: () => boolean
  onSettled: () => void
}): () => void {
  let cancelled = false
  let frameId: number | null = null
  let replaySettledFrameObserved = false
  const scheduleFrame = (): void => {
    frameId = requestAnimationFrame(() => {
      frameId = null
      if (cancelled || !args.isCurrent()) {
        return
      }
      if (!args.isReplaySettled() || !args.isContentReady()) {
        replaySettledFrameObserved = false
        scheduleFrame()
        return
      }
      if (!replaySettledFrameObserved) {
        replaySettledFrameObserved = true
        scheduleFrame()
        return
      }
      args.onSettled()
    })
  }
  void Promise.all(
    args.manager.getPanes().map((pane) => waitForTerminalOutputParsed(pane.terminal))
  ).then(() => {
    if (cancelled || !args.isCurrent()) {
      return
    }
    scheduleFrame()
  })
  return () => {
    cancelled = true
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
    }
  }
}
