import { describe } from 'vitest'
import { registerPtyConnectionForegroundAgentRoutingTests } from '../agent-identity/pty-connection-foreground-agent-routing.spec'
import { registerPtyConnectionForegroundAgentSamplingTests } from '../agent-identity/pty-connection-foreground-agent-sampling.spec'
import { registerPtyConnectionForegroundProcessExitTests } from '../agent-identity/pty-connection-foreground-process-exit.spec'
import { registerPtyConnectionForegroundRoutingConfirmationTests } from '../agent-identity/pty-connection-foreground-routing-confirmation.spec'
import { registerPtyConnectionForegroundFrameSchedulingTests } from '../output/pty-connection-foreground-write-path.spec'
import { registerPtyConnectionInterruptInferenceTests } from '../input/pty-connection-interrupt-inference.spec'
import { registerPtyConnectionTypedAgentIdentityTests } from '../agent-identity/pty-connection-typed-agent-identity.spec'

describe(
  'pty-connection-foreground-agent-routing',
  registerPtyConnectionForegroundAgentRoutingTests
)
describe(
  'pty-connection-foreground-agent-sampling',
  registerPtyConnectionForegroundAgentSamplingTests
)
describe('pty-connection-foreground-process-exit', registerPtyConnectionForegroundProcessExitTests)
describe(
  'pty-connection-foreground-routing-confirmation',
  registerPtyConnectionForegroundRoutingConfirmationTests
)
describe('pty-connection-foreground-write-path', () => {
  registerPtyConnectionForegroundFrameSchedulingTests()
})
describe('pty-connection-interrupt-inference', registerPtyConnectionInterruptInferenceTests)
describe('pty-connection-typed-agent-identity', registerPtyConnectionTypedAgentIdentityTests)
