import { describe, vi } from 'vitest'
import { registerPtyConnectionHiddenOutputSchedulingTests } from '../output/pty-connection-hidden-output-scheduling.spec'
import { registerPtyConnectionHiddenStartupQueryAdmissionTests } from '../emulation/pty-connection-hidden-startup-query-admission.spec'
import { registerPtyConnectionHiddenBacklogReconciliationTests } from '../output-restore/pty-connection-hidden-backlog-reconciliation.spec'
import { registerPtyConnectionHiddenOutputRestoreTests } from '../output-restore/pty-connection-hidden-output-restore.spec'
import {
  registerPtyConnectionHiddenEscapeAdmissionTests,
  registerPtyConnectionHiddenQueryAdmissionTests
} from '../emulation/pty-connection-hidden-query-admission.spec'
import { registerPtyConnectionHiddenSnapshotLiveOverlapTests } from '../output-restore/pty-connection-hidden-snapshot-live-overlap.spec'
import { registerPtyConnectionHiddenSnapshotResizeSignalsTests } from '../output-restore/pty-connection-hidden-snapshot-resize-signals.spec'
import { registerPtyConnectionHiddenResizeAuthorityTests } from '../geometry/pty-connection-hidden-resize-authority.spec'
import { registerPtyConnectionStalledHiddenRestoreTests } from '../output-restore/pty-connection-stalled-hidden-restore.spec'
import { registerPtyConnectionDaemonSnapshotReplayTests } from '../reattach/pty-connection-daemon-snapshot-replay.spec'
import { registerPtyConnectionDeferredReattachLiveOutputTests } from '../reattach/pty-connection-deferred-reattach-live-output.spec'
import { registerPtyConnectionRemotePauseDropNoticeTests } from '../output-restore/pty-connection-remote-pause-drop-notice.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-hidden-atlas-recovery', () => {
  registerPtyConnectionHiddenOutputSchedulingTests()
  registerPtyConnectionHiddenStartupQueryAdmissionTests()
})
describe(
  'pty-connection-hidden-backlog-reconciliation',
  registerPtyConnectionHiddenBacklogReconciliationTests
)
describe('pty-connection-hidden-output-restore', registerPtyConnectionHiddenOutputRestoreTests)
describe('pty-connection-hidden-query-snapshot-restore', () => {
  registerPtyConnectionHiddenEscapeAdmissionTests()
  registerPtyConnectionHiddenQueryAdmissionTests()
})
describe(
  'pty-connection-hidden-snapshot-live-overlap',
  registerPtyConnectionHiddenSnapshotLiveOverlapTests
)
describe('pty-connection-hidden-snapshot-resize-signals', () => {
  registerPtyConnectionHiddenSnapshotResizeSignalsTests()
  registerPtyConnectionHiddenResizeAuthorityTests()
})
describe('pty-connection-stalled-hidden-restore', registerPtyConnectionStalledHiddenRestoreTests)
describe('pty-connection-daemon-snapshot-replay', registerPtyConnectionDaemonSnapshotReplayTests)
describe(
  'pty-connection-deferred-reattach-live-output',
  registerPtyConnectionDeferredReattachLiveOutputTests
)
describe('pty-connection-remote-pause-drop-notice', registerPtyConnectionRemotePauseDropNoticeTests)
