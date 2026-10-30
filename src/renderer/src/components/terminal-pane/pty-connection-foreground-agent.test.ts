import { describe } from 'vitest'
import { registerPtyConnectionForegroundAgentRoutingTests } from './pty-connection-foreground-agent-routing.spec'
import { registerPtyConnectionForegroundAgentSamplingTests } from './pty-connection-foreground-agent-sampling.spec'
import { registerPtyConnectionForegroundProcessExitTests } from './pty-connection-foreground-process-exit.spec'
import { registerPtyConnectionForegroundRoutingConfirmationTests } from './pty-connection-foreground-routing-confirmation.spec'
import { registerPtyConnectionForegroundWritePathTests } from './pty-connection-foreground-write-path.spec'
import { registerPtyConnectionInterruptInferenceTests } from './pty-connection-interrupt-inference.spec'
import { registerPtyConnectionTypedAgentIdentityTests } from './pty-connection-typed-agent-identity.spec'

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
describe('pty-connection-foreground-write-path', registerPtyConnectionForegroundWritePathTests)
describe('pty-connection-interrupt-inference', registerPtyConnectionInterruptInferenceTests)
describe('pty-connection-typed-agent-identity', registerPtyConnectionTypedAgentIdentityTests)
