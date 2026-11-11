import { describe, vi } from 'vitest'

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

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

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
