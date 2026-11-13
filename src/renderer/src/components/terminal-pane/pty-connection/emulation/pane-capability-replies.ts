import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { useAppStore } from '@/store'
import { isPaneReplaying } from '../../snapshots/replay-guard'
import { terminalRendersInlineImages } from '@/lib/pane-manager/terminal-rendering/pane-inline-images'
import { CONPTY_DA1_RESPONSE } from '../../../../../../shared/conpty-device-attributes'
import {
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers
} from '../../emulation/terminal-capability-replies'
import { resolveTerminalOscColorQueryFallback } from '../../emulation/terminal-osc-color-query-fallback'
import { resolveTerminalInlineImagesEnabled } from '../../../../../../shared/terminal/images/terminal-inline-images-settings'
import { PROGRAM_STATUS_RUNTIME_CAPABILITY } from '../../../../../../shared/program-status/protocol'
import { readCachedRuntimeEnvironmentCapability } from '../../../../runtime/rpc/compatibility/runtime-compatibility-cache'

export function bindDesktopCapabilityReplyGate(session: ConnectPanePtySession): void {
  session.canSendDesktopQueryReply = (): boolean => {
    const ptyId = session.transport.getPtyId()
    return !ptyId || !isPtyLocked(ptyId)
  }
  // Capability handlers bypass onData; mobile ownership must silence desktop replies here too.
  session.sendDesktopQueryReplyImmediate = (data: string): boolean =>
    session.canSendDesktopQueryReply() && session.transport.sendInputImmediate(data)
}

export function installPaneCapabilityReplies(session: ConnectPanePtySession): void {
  session.terminalCapabilityRepliesDisposable = installTerminalCapabilityReplyHandlers({
    terminal: session.pane.terminal,
    parser: session.pane.terminal.parser,
    // Send query replies immediately to beat raw-mode read windows; remote input debounce can corrupt late replies (#7329).
    sendInput: session.sendDesktopQueryReplyImmediate,
    isReplaying: () => isPaneReplaying(session.deps.replayingPanesRef, session.pane.id),
    // Advertise Sixel only after decoder attachment; enabled settings can precede lazy load or survive a failed load.
    sixelSupported: () =>
      resolveTerminalInlineImagesEnabled(useAppStore.getState().settings?.terminalInlineImages) &&
      terminalRendersInlineImages(session.pane.terminal),
    skipOscColorQueryReplies: () => !session.shouldAnswerPaneOscColorQueries(),
    // Always answer from the composed appearance when the live theme object lost fg/bg (#32242, #39529).
    colorQueryFallback: () => resolveTerminalOscColorQueryFallback(useAppStore.getState().settings),
    answerProgramStatusQueries: () =>
      !session.runtimeEnvironmentId ||
      readCachedRuntimeEnvironmentCapability(
        session.runtimeEnvironmentId,
        PROGRAM_STATUS_RUNTIME_CAPABILITY
      ) === true,
    ...(session.isNativeWindowsConpty ? { da1Response: CONPTY_DA1_RESPONSE } : {})
  })
  session.respondToTerminalPixelSizeQueries = createTerminalPixelSizeQueryResponder(
    session.pane.terminal,
    session.sendDesktopQueryReplyImmediate
  )
}
