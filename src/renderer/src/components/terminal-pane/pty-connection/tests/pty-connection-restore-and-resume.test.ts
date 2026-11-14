import { describe, vi } from 'vitest'

import { registerPtyConnectionColdRestoreRepaintTests } from '../reattach/pty-connection-cold-restore-repaint.spec'

import { registerPtyConnectionRestartReplacementDisposeTests } from '../spawn/pty-connection-restart-replacement-stop-claim.spec'
import { registerPtyConnectionSetupAutoCloseTests } from '../lifecycle/pty-connection-setup-auto-close.spec'
import { registerPtyConnectionOwnerErrorRetryTests } from '../reattach/pty-connection-owner-error-retry.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-cold-restore-repaint', registerPtyConnectionColdRestoreRepaintTests)

describe('pty-connection-hibernation-wake', () => {
  registerPtyConnectionRestartReplacementDisposeTests()
})

describe('pty-connection-session-liveness', () => {
  registerPtyConnectionOwnerErrorRetryTests()
})
describe('pty-connection-setup-auto-close', registerPtyConnectionSetupAutoCloseTests)
