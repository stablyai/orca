import { describe, vi } from 'vitest'
import { registerPtyConnectionVisibilityResumeSizeTests } from '../geometry/pty-connection-visibility-resume-size.spec'
import { registerPtyConnectionHiddenCodexQueriesTests } from '../emulation/pty-connection-hidden-codex-queries.spec'
import { registerPtyConnectionHiddenQuerySnapshotAuthorityTests } from '../output-restore/pty-connection-hidden-query-snapshot-authority.spec'
import { registerPtyConnectionHiddenDeliveryGateTests } from '../output-restore/pty-connection-hidden-delivery-gate.spec'
import { registerPtyConnectionParkRevealModelSnapshotTests } from '../reattach/pty-connection-park-reveal-model-snapshot.spec'
import { registerPtyConnectionReplayPayloadHandlingTests } from '../output-restore/pty-connection-replay-payload-handling.spec'
import {
  registerPtyConnectionPtyExitTeardownTests,
  registerPtyConnectionEstablishedPtyExitTests
} from '../lifecycle/pty-connection-pty-exit-teardown.spec'
import { registerPtyConnectionProviderRebindCallbackFencingTests } from '../lifecycle/pty-connection-provider-rebind-callback-fencing.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-visibility-resume-size', registerPtyConnectionVisibilityResumeSizeTests)
describe('pty-connection-hidden-codex-queries', () => {
  registerPtyConnectionHiddenCodexQueriesTests()
  registerPtyConnectionHiddenQuerySnapshotAuthorityTests()
})
describe('pty-connection-hidden-delivery-gate', registerPtyConnectionHiddenDeliveryGateTests)
describe(
  'pty-connection-park-reveal-model-snapshot',
  registerPtyConnectionParkRevealModelSnapshotTests
)
describe('pty-connection-replay-payload-handling', registerPtyConnectionReplayPayloadHandlingTests)
describe('pty-connection-pty-exit-teardown', () => {
  registerPtyConnectionPtyExitTeardownTests()
  registerPtyConnectionProviderRebindCallbackFencingTests()
  registerPtyConnectionEstablishedPtyExitTests()
})
