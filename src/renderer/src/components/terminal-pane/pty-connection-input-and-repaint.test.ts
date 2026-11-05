import { describe, vi } from 'vitest'
import { registerPtyConnectionKittyKeyboardRestoreTests } from './pty-connection-kitty-keyboard-restore.spec'
import { registerPtyConnectionMode2031SubscriptionsTests } from './pty-connection-mode-2031-subscriptions.spec'
import { registerPtyConnectionReattachModeResetTests } from './pty-connection-reattach-mode-reset.spec'
import { registerPtyConnectionWindowsKeyboardResetTests } from './pty-connection-windows-keyboard-reset.spec'
import { registerPtyConnectionWindowsCjkRepaintTests } from './pty-connection-windows-cjk-repaint.spec'
import { registerPtyConnectionRendererRiskRepaintTests } from './pty-connection-renderer-risk-repaint.spec'
import { registerPtyConnectionTerminalInputGatingTests } from './pty-connection-terminal-input-gating.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-kitty-keyboard-restore', registerPtyConnectionKittyKeyboardRestoreTests)
describe('pty-connection-mode-2031-subscriptions', registerPtyConnectionMode2031SubscriptionsTests)
describe('pty-connection-reattach-mode-reset', registerPtyConnectionReattachModeResetTests)
describe('pty-connection-windows-keyboard-reset', registerPtyConnectionWindowsKeyboardResetTests)
describe('pty-connection-windows-cjk-repaint', registerPtyConnectionWindowsCjkRepaintTests)
describe('pty-connection-renderer-risk-repaint', registerPtyConnectionRendererRiskRepaintTests)
describe('pty-connection-terminal-input-gating', registerPtyConnectionTerminalInputGatingTests)
