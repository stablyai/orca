import { describe, vi } from 'vitest'

import { registerPtyConnectionHiddenQuerySnapshotAuthorityTests } from '../output-restore/pty-connection-hidden-query-snapshot-authority.spec'

import {
  registerPtyConnectionPtyExitTeardownTests,
  registerPtyConnectionEstablishedPtyExitTests
} from '../lifecycle/pty-connection-pty-exit-teardown.spec'
import { registerPtyConnectionProviderRebindCallbackFencingTests } from '../lifecycle/pty-connection-provider-rebind-callback-fencing.spec'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

describe('pty-connection-hidden-codex-queries', () => {
  registerPtyConnectionHiddenQuerySnapshotAuthorityTests()
})

describe('pty-connection-pty-exit-teardown', () => {
  registerPtyConnectionPtyExitTeardownTests()
  registerPtyConnectionProviderRebindCallbackFencingTests()
  registerPtyConnectionEstablishedPtyExitTests()
})
