import { describe, vi } from 'vitest'
import {
  registerPtyConnectionSleepingRecordResumeTests,
  registerPtyConnectionLiveResumeIdentityTests
} from '../reattach/pty-connection-agent-session-resume.spec'
import { registerPtyConnectionColdRestoreAgentResumeTests } from '../reattach/pty-connection-cold-restore-agent-resume.spec'
import { registerPtyConnectionColdRestoreRepaintTests } from '../reattach/pty-connection-cold-restore-repaint.spec'
import { registerPtyConnectionColdRestoreResumeCommandTests } from '../reattach/pty-connection-cold-restore-resume-command.spec'
import {
  registerPtyConnectionHibernationWakeTests,
  registerPtyConnectionHibernationWakeClaimTests
} from '../lifecycle/pty-connection-hibernation-wake.spec'
import { registerPtyConnectionRestartReplacementDisposeTests } from '../spawn/pty-connection-restart-replacement-stop-claim.spec'
import { registerPtyConnectionHiddenSleepingResumeTests } from '../lifecycle/pty-connection-hidden-sleeping-resume.spec'
import { registerPtyConnectionSessionLivenessTests } from '../lifecycle/pty-connection-session-liveness.spec'
import { registerPtyConnectionOwnerErrorRetryTests } from '../reattach/pty-connection-owner-error-retry.spec'
import { registerPtyConnectionSleepingResumeBannerTests } from '../spawn/pty-connection-sleeping-resume-banner.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-agent-session-resume', () => {
  registerPtyConnectionSleepingRecordResumeTests()
  registerPtyConnectionLiveResumeIdentityTests()
})
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
  registerPtyConnectionHibernationWakeTests()
  registerPtyConnectionRestartReplacementDisposeTests()
  registerPtyConnectionHibernationWakeClaimTests()
})
describe('pty-connection-hidden-sleeping-resume', registerPtyConnectionHiddenSleepingResumeTests)
describe('pty-connection-session-liveness', () => {
  registerPtyConnectionSessionLivenessTests()
  registerPtyConnectionOwnerErrorRetryTests()
})
describe('pty-connection-sleeping-resume-banner', registerPtyConnectionSleepingResumeBannerTests)
