import { describe } from 'vitest'
import { registerPtyConnectionAgentSessionResumeTests } from './pty-connection-agent-session-resume.spec'
import { registerPtyConnectionColdRestoreAgentResumeTests } from './pty-connection-cold-restore-agent-resume.spec'
import { registerPtyConnectionColdRestoreRepaintTests } from './pty-connection-cold-restore-repaint.spec'
import { registerPtyConnectionColdRestoreResumeCommandTests } from './pty-connection-cold-restore-resume-command.spec'
import { registerPtyConnectionHibernationWakeTests } from './pty-connection-hibernation-wake.spec'
import { registerPtyConnectionHiddenSleepingResumeTests } from './pty-connection-hidden-sleeping-resume.spec'
import { registerPtyConnectionRestartReplacementTests } from './pty-connection-restart-replacement.spec'
import { registerPtyConnectionSessionLivenessTests } from './pty-connection-session-liveness.spec'
import { registerPtyConnectionSleepingResumeBannerTests } from './pty-connection-sleeping-resume-banner.spec'

describe('pty-connection-agent-session-resume', registerPtyConnectionAgentSessionResumeTests)
describe(
  'pty-connection-cold-restore-agent-resume',
  registerPtyConnectionColdRestoreAgentResumeTests
)
describe('pty-connection-cold-restore-repaint', registerPtyConnectionColdRestoreRepaintTests)
describe(
  'pty-connection-cold-restore-resume-command',
  registerPtyConnectionColdRestoreResumeCommandTests
)
describe('pty-connection-hibernation-wake', registerPtyConnectionHibernationWakeTests)
describe('pty-connection-hidden-sleeping-resume', registerPtyConnectionHiddenSleepingResumeTests)
describe('pty-connection-restart-replacement', registerPtyConnectionRestartReplacementTests)
describe('pty-connection-session-liveness', registerPtyConnectionSessionLivenessTests)
describe('pty-connection-sleeping-resume-banner', registerPtyConnectionSleepingResumeBannerTests)
