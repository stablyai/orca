import { describe, vi } from 'vitest'
import { registerPtyConnectionHiddenAtlasRecoveryTests } from './pty-connection-hidden-atlas-recovery.spec'
import { registerPtyConnectionHiddenBacklogReconciliationTests } from './pty-connection-hidden-backlog-reconciliation.spec'
import { registerPtyConnectionHiddenOutputRestoreTests } from './pty-connection-hidden-output-restore.spec'
import { registerPtyConnectionHiddenQuerySnapshotRestoreTests } from './pty-connection-hidden-query-snapshot-restore.spec'
import { registerPtyConnectionHiddenSnapshotLiveOverlapTests } from './pty-connection-hidden-snapshot-live-overlap.spec'
import { registerPtyConnectionHiddenSnapshotResizeSignalsTests } from './pty-connection-hidden-snapshot-resize-signals.spec'
import { registerPtyConnectionHiddenTuiSnapshotReplayTests } from './pty-connection-hidden-tui-snapshot-replay.spec'
import { registerPtyConnectionStalledHiddenRestoreTests } from './pty-connection-stalled-hidden-restore.spec'
import { registerPtyConnectionDaemonSnapshotReplayTests } from './pty-connection-daemon-snapshot-replay.spec'
import { registerPtyConnectionDeferredReattachLiveOutputTests } from './pty-connection-deferred-reattach-live-output.spec'
import { registerPtyConnectionRemotePauseDropNoticeTests } from './pty-connection-remote-pause-drop-notice.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-hidden-atlas-recovery', registerPtyConnectionHiddenAtlasRecoveryTests)
describe(
  'pty-connection-hidden-backlog-reconciliation',
  registerPtyConnectionHiddenBacklogReconciliationTests
)
describe('pty-connection-hidden-output-restore', registerPtyConnectionHiddenOutputRestoreTests)
describe(
  'pty-connection-hidden-query-snapshot-restore',
  registerPtyConnectionHiddenQuerySnapshotRestoreTests
)
describe(
  'pty-connection-hidden-snapshot-live-overlap',
  registerPtyConnectionHiddenSnapshotLiveOverlapTests
)
describe(
  'pty-connection-hidden-snapshot-resize-signals',
  registerPtyConnectionHiddenSnapshotResizeSignalsTests
)
describe(
  'pty-connection-hidden-tui-snapshot-replay',
  registerPtyConnectionHiddenTuiSnapshotReplayTests
)
describe('pty-connection-stalled-hidden-restore', registerPtyConnectionStalledHiddenRestoreTests)
describe('pty-connection-daemon-snapshot-replay', registerPtyConnectionDaemonSnapshotReplayTests)
describe(
  'pty-connection-deferred-reattach-live-output',
  registerPtyConnectionDeferredReattachLiveOutputTests
)
describe('pty-connection-remote-pause-drop-notice', registerPtyConnectionRemotePauseDropNoticeTests)
