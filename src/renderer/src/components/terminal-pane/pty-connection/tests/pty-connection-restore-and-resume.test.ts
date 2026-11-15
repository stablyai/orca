import { describe, vi } from 'vitest'
import { registerPtyConnectionColdRestoreAgentResumeTests } from '../reattach/pty-connection-cold-restore-agent-resume.spec'
import { registerPtyConnectionColdRestoreRepaintTests } from '../reattach/pty-connection-cold-restore-repaint.spec'
import { registerPtyConnectionColdRestoreResumeCommandTests } from '../reattach/pty-connection-cold-restore-resume-command.spec'
import { registerPtyConnectionRestartReplacementDisposeTests } from '../spawn/pty-connection-restart-replacement-stop-claim.spec'
import { registerPtyConnectionHiddenSleepingResumeTests } from '../lifecycle/pty-connection-hidden-sleeping-resume.spec'
import { registerPtyConnectionSessionLivenessTests } from '../lifecycle/pty-connection-session-liveness.spec'
import { registerPtyConnectionOwnerErrorRetryTests } from '../reattach/pty-connection-owner-error-retry.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe(
  'pty-connection-cold-restore-agent-resume',
  registerPtyConnectionColdRestoreAgentResumeTests
)
describe('pty-connection-cold-restore-repaint', registerPtyConnectionColdRestoreRepaintTests)
describe(
  'pty-connection-cold-restore-resume-command',
  registerPtyConnectionColdRestoreResumeCommandTests
)
describe('pty-connection-hibernation-wake', () => {
  registerPtyConnectionRestartReplacementDisposeTests()
})
describe('pty-connection-hidden-sleeping-resume', registerPtyConnectionHiddenSleepingResumeTests)
describe('pty-connection-session-liveness', () => {
  registerPtyConnectionSessionLivenessTests()
  registerPtyConnectionOwnerErrorRetryTests()
})
