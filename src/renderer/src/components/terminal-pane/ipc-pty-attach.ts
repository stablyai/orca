import { ensurePtyDispatcher, getEagerPtyBufferHandle } from './pty-dispatcher'
import {
  hasTerminalDisplayContent,
  trimIncompleteTerminalControlTail
} from './terminal-output-visibility'
import type { createPtyOutputProcessor } from './pty-output-processor'
import type { IpcPtySessionHandlers } from './ipc-pty-session-handlers'
import type { PtyTransport } from './pty-transport-types'

type PtyAttachOptions = Parameters<PtyTransport['attach']>[0]

type IpcPtyAttachContext = {
  handlers: IpcPtySessionHandlers
  outputProcessor: ReturnType<typeof createPtyOutputProcessor>
  isDestroyed: () => boolean
  bind: (id: string) => void
  isCurrent: (id: string) => boolean
  setCallbacks: (callbacks: PtyAttachOptions['callbacks']) => void
  setSuppressAttentionEvents: (value: boolean) => void
}

export function attachIpcPty(options: PtyAttachOptions, context: IpcPtyAttachContext): void {
  context.setCallbacks(options.callbacks)
  ensurePtyDispatcher()
  if (context.isDestroyed()) {
    return
  }

  const id = options.existingPtyId
  context.bind(id)
  context.handlers.registerData(id)
  context.handlers.registerExit(id)
  if (!context.isCurrent(id)) {
    return
  }

  replayEagerPtyBuffer(options, context)
  if (options.cols && options.rows) {
    window.api.pty.resize(id, options.cols, options.rows)
  }
  options.callbacks.onConnect?.()
  options.callbacks.onStatus?.('shell')
}

function replayEagerPtyBuffer(options: PtyAttachOptions, context: IpcPtyAttachContext): void {
  const bufferHandle = getEagerPtyBufferHandle(options.existingPtyId)
  if (!bufferHandle) {
    return
  }
  const buffered = bufferHandle.flush()
  if (buffered) {
    const replayData = trimIncompleteTerminalControlTail(buffered)
    const shouldClearBeforeReplay =
      !options.isAlternateScreen && hasTerminalDisplayContent(replayData)
    if (shouldClearBeforeReplay && !options.callbacks.onReplayData) {
      options.callbacks.onData?.('\x1b[2J\x1b[3J\x1b[H')
    }

    context.setSuppressAttentionEvents(true)
    try {
      context.outputProcessor.processData(replayData, options.callbacks, {
        replayingBufferedData: true,
        suppressAttentionEvents: true,
        clearBeforeReplay: shouldClearBeforeReplay
      })
    } finally {
      context.outputProcessor.flushPendingSideEffects()
      context.setSuppressAttentionEvents(false)
      context.outputProcessor.clearStaleTitleTimer()
      context.outputProcessor.resetBellDetector()
    }
  }
  bufferHandle.dispose()
}
