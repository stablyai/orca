import { describe } from 'vitest'
import { registerPtyConnectionCommandFinishedCleanupTests } from './pty-connection-command-finished-cleanup.spec'
import { registerPtyConnectionHookCompletionBellArbitrationTests } from './pty-connection-hook-completion-bell-arbitration.spec'
import { registerPtyConnectionHookCompletionSideEffectsTests } from './pty-connection-hook-completion-side-effects.spec'
import { registerPtyConnectionMainSideEffectAuthorityTests } from './pty-connection-main-side-effect-authority.spec'
import { registerPtyConnectionNotificationSettingsGatingTests } from './pty-connection-notification-settings-gating.spec'
import { registerPtyConnectionTaskCompleteDispatchTests } from './pty-connection-task-complete-dispatch.spec'
import { registerPtyConnectionUnansweredCommandFinishTests } from './pty-connection-unanswered-command-finish.spec'

describe(
  'pty-connection-command-finished-cleanup',
  registerPtyConnectionCommandFinishedCleanupTests
)
describe(
  'pty-connection-hook-completion-bell-arbitration',
  registerPtyConnectionHookCompletionBellArbitrationTests
)
describe(
  'pty-connection-hook-completion-side-effects',
  registerPtyConnectionHookCompletionSideEffectsTests
)
describe(
  'pty-connection-main-side-effect-authority',
  registerPtyConnectionMainSideEffectAuthorityTests
)
describe(
  'pty-connection-notification-settings-gating',
  registerPtyConnectionNotificationSettingsGatingTests
)
describe('pty-connection-task-complete-dispatch', registerPtyConnectionTaskCompleteDispatchTests)
describe(
  'pty-connection-unanswered-command-finish',
  registerPtyConnectionUnansweredCommandFinishTests
)
