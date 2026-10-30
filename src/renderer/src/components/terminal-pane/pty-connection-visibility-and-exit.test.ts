import { describe, vi } from 'vitest'
import { registerPtyConnectionVisibilityResumeSizeTests } from './pty-connection-visibility-resume-size.spec'
import { registerPtyConnectionMobileOverlayRefreshTests } from './pty-connection-mobile-overlay-refresh.spec'
import { registerPtyConnectionHiddenCodexQueriesTests } from './pty-connection-hidden-codex-queries.spec'
import { registerPtyConnectionHiddenDeliveryGateTests } from './pty-connection-hidden-delivery-gate.spec'
import { registerPtyConnectionParkRevealModelSnapshotTests } from './pty-connection-park-reveal-model-snapshot.spec'
import { registerPtyConnectionReplayPayloadHandlingTests } from './pty-connection-replay-payload-handling.spec'
import { registerPtyConnectionPtyExitTeardownTests } from './pty-connection-pty-exit-teardown.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-visibility-resume-size', registerPtyConnectionVisibilityResumeSizeTests)
describe('pty-connection-mobile-overlay-refresh', registerPtyConnectionMobileOverlayRefreshTests)
describe('pty-connection-hidden-codex-queries', registerPtyConnectionHiddenCodexQueriesTests)
describe('pty-connection-hidden-delivery-gate', registerPtyConnectionHiddenDeliveryGateTests)
describe(
  'pty-connection-park-reveal-model-snapshot',
  registerPtyConnectionParkRevealModelSnapshotTests
)
describe('pty-connection-replay-payload-handling', registerPtyConnectionReplayPayloadHandlingTests)
describe('pty-connection-pty-exit-teardown', registerPtyConnectionPtyExitTeardownTests)
