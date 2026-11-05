import { describe } from 'vitest'
import { registerPtyConnectionPendingSpawnTests } from './pty-connection-pending-spawn.spec'
import { registerPtyConnectionFreshSpawnGuardsTests } from './pty-connection-fresh-spawn-guards.spec'
import { registerPtyConnectionSplitSpawnTests } from './pty-connection-split-spawn.spec'
import { registerPtyConnectionRuntimeOwnerSpawnRoutingTests } from './pty-connection-runtime-owner-spawn-routing.spec'
import { registerPtyConnectionStartupCommandDeliveryTests } from './pty-connection-startup-command-delivery.spec'
import { registerPtyConnectionStartupDraftDeliveryTests } from './pty-connection-startup-draft-delivery.spec'
import { registerPtyConnectionDeliberateSleepGuardTests } from './pty-connection-deliberate-sleep-guard.spec'
import { registerPtyConnectionRemoteRuntimeAttachTests } from './pty-connection-remote-runtime-attach.spec'

describe('pty-connection-pending-spawn', registerPtyConnectionPendingSpawnTests)
describe('pty-connection-fresh-spawn-guards', registerPtyConnectionFreshSpawnGuardsTests)
describe('pty-connection-split-spawn', registerPtyConnectionSplitSpawnTests)
describe(
  'pty-connection-runtime-owner-spawn-routing',
  registerPtyConnectionRuntimeOwnerSpawnRoutingTests
)
describe(
  'pty-connection-startup-command-delivery',
  registerPtyConnectionStartupCommandDeliveryTests
)
describe('pty-connection-startup-draft-delivery', registerPtyConnectionStartupDraftDeliveryTests)
describe('pty-connection-deliberate-sleep-guard', registerPtyConnectionDeliberateSleepGuardTests)
describe('pty-connection-remote-runtime-attach', registerPtyConnectionRemoteRuntimeAttachTests)
