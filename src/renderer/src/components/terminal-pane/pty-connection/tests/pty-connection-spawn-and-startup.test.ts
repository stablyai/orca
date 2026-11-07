import { registerPtyConnectionRendererDrawingGlyphTests } from '../output/pty-connection-renderer-risk-repaint.spec'
import { describe } from 'vitest'
import { registerPtyConnectionPendingSpawnTests } from '../spawn/pty-connection-pending-spawn.spec'
import { registerPtyConnectionFreshSpawnGuardsTests } from '../spawn/pty-connection-fresh-spawn-guards.spec'
import { registerPtyConnectionSplitSpawnTests } from '../spawn/pty-connection-split-spawn.spec'
import { registerPtyConnectionRuntimeOwnerSpawnRoutingTests } from '../host-ownership/pty-connection-runtime-owner-spawn-routing.spec'
import { registerPtyConnectionStartupCwdFallbackNoticeTests } from '../startup/pty-connection-startup-cwd-fallback-notice.spec'
import { registerPtyConnectionRestoredRuntimePaneBindingTests } from '../reattach/pty-connection-restored-runtime-pane-binding.spec'
import { registerPtyConnectionTerminalBellAttentionTests } from '../notifications/pty-connection-terminal-bell-attention.spec'
import {
  registerPtyConnectionLocalStartupCommandDeliveryTests,
  registerPtyConnectionTerminalPasteStartupCommandDeliveryTests
} from '../startup/pty-connection-startup-command-delivery.spec'
import { registerPtyConnectionCommandCodeStatusInferenceTests } from '../agent-identity/pty-connection-command-code-status-inference.spec'
import { registerPtyConnectionStartupDraftDeliveryTests } from '../startup/pty-connection-startup-draft-delivery.spec'
import { registerPtyConnectionDeliberateSleepGuardTests } from '../lifecycle/pty-connection-deliberate-sleep-guard.spec'
import { registerPtyConnectionRemoteRuntimeAttachTests } from '../reattach/pty-connection-remote-runtime-attach.spec'
import { registerPtyConnectionRuntimePaneTransportRoutingTests } from '../host-ownership/pty-connection-runtime-pane-transport-routing.spec'

describe('pty-connection-pending-spawn', registerPtyConnectionPendingSpawnTests)
describe('pty-connection-fresh-spawn-guards', registerPtyConnectionFreshSpawnGuardsTests)
describe('pty-connection-split-spawn', registerPtyConnectionSplitSpawnTests)
describe('pty-connection-runtime-owner-spawn-routing', () => {
  registerPtyConnectionRuntimeOwnerSpawnRoutingTests()
  registerPtyConnectionStartupCwdFallbackNoticeTests()
  registerPtyConnectionRestoredRuntimePaneBindingTests()
  registerPtyConnectionTerminalBellAttentionTests()
})
describe('pty-connection-startup-command-delivery', () => {
  registerPtyConnectionLocalStartupCommandDeliveryTests()
  registerPtyConnectionCommandCodeStatusInferenceTests()
  registerPtyConnectionTerminalPasteStartupCommandDeliveryTests()
})
describe('pty-connection-startup-draft-delivery', registerPtyConnectionStartupDraftDeliveryTests)
describe('pty-connection-deliberate-sleep-guard', registerPtyConnectionDeliberateSleepGuardTests)
describe('pty-connection-remote-runtime-attach', () => {
  registerPtyConnectionRendererDrawingGlyphTests()
  registerPtyConnectionRemoteRuntimeAttachTests()
  registerPtyConnectionRuntimePaneTransportRoutingTests()
})
