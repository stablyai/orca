import { describe } from 'vitest'
import { registerPtyConnectionCommandFinishedCleanupTests } from '../agent-identity/pty-connection-command-finished-cleanup.spec'
import { registerPtyConnectionMainSideEffectAuthorityTests } from '../emulation/pty-connection-main-side-effect-authority.spec'

describe('pty-connection-command-finished-cleanup', () => {
  registerPtyConnectionCommandFinishedCleanupTests()
})
describe(
  'pty-connection-main-side-effect-authority',
  registerPtyConnectionMainSideEffectAuthorityTests
)
