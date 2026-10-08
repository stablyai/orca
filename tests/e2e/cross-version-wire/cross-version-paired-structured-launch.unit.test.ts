import { beforeAll, describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { resolveStructuredNativeChatSupport } from '../../../src/shared/structured-native-chat-launch-route'
import { resolveAgentLaunchRoute } from '../../../src/renderer/src/lib/agent-launch-routing'
import { pairedHostClientCapabilities } from '../../../src/renderer/src/runtime/paired-host-client-capabilities'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// The capability strings a released server really advertises, not hand-written ones: a renamed
// string would follow along in unit tests but silently change what this desktop does with that server.
// This release advertises structured chat but predates client-chosen launch modes.
const LEGACY_PAIRED_STRUCTURED_LAUNCH_RELEASE_REF = 'v1.4.219'
const SETTINGS = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

let legacyHostCapabilities: readonly string[]

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(LEGACY_PAIRED_STRUCTURED_LAUNCH_RELEASE_REF)
  const protocol = await importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')
  const capabilities = protocol.RUNTIME_CAPABILITIES
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((value: unknown): value is string => typeof value === 'string')
  ) {
    throw new Error('The legacy release must publish its runtime capabilities')
  }
  legacyHostCapabilities = capabilities
}, 180_000)

describe(`a current desktop paired with a ${LEGACY_PAIRED_STRUCTURED_LAUNCH_RELEASE_REF} server`, () => {
  it('finds structured chat advertised under the name it checks, without client-chosen launch modes', () => {
    expect(legacyHostCapabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(legacyHostCapabilities).not.toContain(
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    )
  })

  it.each(['claude', 'codex'] as const)(
    'keeps %s on the terminal there, and opens a chat once the server is current',
    (agent) => {
      const launch = {
        agent,
        workspaceKind: 'git-worktree',
        executionHostId: 'runtime:server-1',
        clientCapabilities: pairedHostClientCapabilities()
      } as const
      const legacy = { ...launch, hostCapabilities: legacyHostCapabilities }
      expect(resolveStructuredNativeChatSupport(legacy)).toEqual({
        supported: false,
        blocker: 'runtime-capability'
      })
      expect(resolveAgentLaunchRoute({ ...legacy, settings: SETTINGS })).toBe('legacy-native-chat')
      // The same handshake against today's server: the refusal above is the old server's doing.
      expect(
        resolveAgentLaunchRoute({
          ...launch,
          hostCapabilities: RUNTIME_CAPABILITIES,
          settings: SETTINGS
        })
      ).toBe('structured-native-chat')
    }
  )
})
