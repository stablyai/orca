import { describe } from 'vitest'
import { registerPtyConnectionCommandFinishedCleanupTests } from '../agent-identity/pty-connection-command-finished-cleanup.spec'
import { registerPtyConnectionCommandFinishedInterruptArbitrationTests } from '../input/pty-connection-command-finished-interrupt-arbitration.spec'
import { registerPtyConnectionHookCompletionSideEffectsTests } from '../notifications/pty-connection-hook-completion-side-effects.spec'
import { registerPtyConnectionMainSideEffectAuthorityTests } from '../emulation/pty-connection-main-side-effect-authority.spec'
import { registerPtyConnectionTaskCompleteDispatchTests } from '../notifications/pty-connection-task-complete-dispatch.spec'

describe('pty-connection-command-finished-cleanup', () => {
  registerPtyConnectionCommandFinishedCleanupTests()
  registerPtyConnectionCommandFinishedInterruptArbitrationTests()
})
describe(
  'pty-connection-hook-completion-side-effects',
  registerPtyConnectionHookCompletionSideEffectsTests
)
describe(
  'pty-connection-main-side-effect-authority',
  registerPtyConnectionMainSideEffectAuthorityTests
)
describe('pty-connection-task-complete-dispatch', registerPtyConnectionTaskCompleteDispatchTests)
