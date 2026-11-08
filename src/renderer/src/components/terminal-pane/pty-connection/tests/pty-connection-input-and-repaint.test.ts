import { describe, vi } from 'vitest'
import { registerPtyConnectionKittyKeyboardRestoreTests } from './input-modes/pty-connection-kitty-keyboard-restore.spec'
import { registerPtyConnectionMode2031SubscriptionsTests } from '../emulation/pty-connection-mode-2031-subscriptions.spec'
import {
  registerPtyConnectionDaemonPendingEscapeTailTests,
  registerPtyConnectionReattachModeResetTests
} from '../reattach/pty-connection-reattach-mode-reset.spec'
import { registerPtyConnectionNativeQueryReplyRoutingTests } from '../input/pty-connection-native-query-reply-routing.spec'
import {
  registerPtyConnectionAgentIdleCursorResetTests,
  registerPtyConnectionWindowsCompletedTurnCursorResetTests,
  registerPtyConnectionWindowsCursorResetDisposalTests
} from '../emulation/pty-connection-agent-idle-cursor-reset.spec'
import {
  registerPtyConnectionRemoteWindowsFocusReportTests,
  registerPtyConnectionWindowsFocusReportAuthorityTests
} from '../input/pty-connection-windows-focus-report-authority.spec'
import { registerPtyConnectionWindowsCjkRepaintTests } from '../output/pty-connection-windows-cjk-repaint.spec'
import { registerPtyConnectionRendererRiskRepaintTests } from '../output/pty-connection-renderer-risk-repaint.spec'
import { registerPtyConnectionTerminalInputGatingTests } from '../input/pty-connection-terminal-input-gating.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-kitty-keyboard-restore', registerPtyConnectionKittyKeyboardRestoreTests)
describe('pty-connection-mode-2031-subscriptions', registerPtyConnectionMode2031SubscriptionsTests)
describe('pty-connection-reattach-mode-reset', () => {
  registerPtyConnectionDaemonPendingEscapeTailTests()
  registerPtyConnectionNativeQueryReplyRoutingTests()
  registerPtyConnectionReattachModeResetTests()
})
describe('pty-connection-windows-keyboard-reset', () => {
  registerPtyConnectionAgentIdleCursorResetTests()
  registerPtyConnectionRemoteWindowsFocusReportTests()
  registerPtyConnectionWindowsCompletedTurnCursorResetTests()
  registerPtyConnectionWindowsFocusReportAuthorityTests()
  registerPtyConnectionWindowsCursorResetDisposalTests()
})
describe('pty-connection-windows-cjk-repaint', registerPtyConnectionWindowsCjkRepaintTests)
describe('pty-connection-renderer-risk-repaint', registerPtyConnectionRendererRiskRepaintTests)
describe('pty-connection-terminal-input-gating', registerPtyConnectionTerminalInputGatingTests)
