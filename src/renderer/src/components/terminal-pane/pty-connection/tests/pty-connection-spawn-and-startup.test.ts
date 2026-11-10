import { describe } from 'vitest'
import { registerPtyConnectionPendingSpawnTests } from '../spawn/pty-connection-pending-spawn.spec'
import { registerPtyConnectionSplitSpawnTests } from '../spawn/pty-connection-split-spawn.spec'
import { registerPtyConnectionRestoredRuntimePaneBindingTests } from '../reattach/pty-connection-restored-runtime-pane-binding.spec'
import { registerPtyConnectionTerminalPasteStartupCommandDeliveryTests } from '../startup/pty-connection-startup-command-delivery.spec'
import { registerPtyConnectionCommandCodeStatusInferenceTests } from '../agent-identity/pty-connection-command-code-status-inference.spec'
import { registerPtyConnectionStartupDraftDeliveryTests } from '../startup/pty-connection-startup-draft-delivery.spec'
import { registerPtyConnectionDeliberateSleepGuardTests } from '../lifecycle/pty-connection-deliberate-sleep-guard.spec'
import { registerPtyConnectionRemoteRuntimeAttachTests } from '../reattach/pty-connection-remote-runtime-attach.spec'
import { registerPtyConnectionRuntimePaneTransportRoutingTests } from '../host-ownership/pty-connection-runtime-pane-transport-routing.spec'

describe('pty-connection-pending-spawn', registerPtyConnectionPendingSpawnTests)
describe('pty-connection-split-spawn', registerPtyConnectionSplitSpawnTests)
describe('pty-connection-runtime-owner-spawn-routing', () => {
  registerPtyConnectionRestoredRuntimePaneBindingTests()
})
describe('pty-connection-startup-command-delivery', () => {
  registerPtyConnectionCommandCodeStatusInferenceTests()
  registerPtyConnectionTerminalPasteStartupCommandDeliveryTests()
})
describe('pty-connection-startup-draft-delivery', registerPtyConnectionStartupDraftDeliveryTests)
describe('pty-connection-deliberate-sleep-guard', registerPtyConnectionDeliberateSleepGuardTests)
describe('pty-connection-remote-runtime-attach', () => {
  registerPtyConnectionRemoteRuntimeAttachTests()
  registerPtyConnectionRuntimePaneTransportRoutingTests()
})
