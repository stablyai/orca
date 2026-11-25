// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { activateTerminalTabOnOwner } from './terminal-tab-owner-activation'

// Loading the real module subscribes to main's pane list; no pane here is relay-bridged.
vi.mock('@/components/terminal-pane/pty-transport/legacy-relay/legacy-relay-bridge-panes', () => ({
  hasLegacyRelayBridgedPane: () => false,
  isLegacyRelayBridgedTab: () => false
}))

type SentRequest = { method: string; expectedEnvironmentPairingRevision?: number }
let sent: SentRequest[] = []

beforeEach(() => {
  sent = []
  Object.assign(window, {
    api: {
      runtimeEnvironments: {
        call: async (request: SentRequest) => {
          sent.push(request)
          return { id: 'fixture', ok: true, result: { activated: true }, _meta: { runtimeId: 'r' } }
        }
      }
    }
  })
})

afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
})

it('sends owner activation under the pairing current at the click, not one made during the lazy load', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
  activateTerminalTabOnOwner('repo::/sample', 'tab-1', 'leaf-1', 'env-1')
  // Re-paired in the same turn, before activation's lazy import resolves.
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 8 }])

  await vi.waitFor(() => expect(sent.some((r) => r.method === 'session.tabs.activate')).toBe(true))
  const activation = sent.find((r) => r.method === 'session.tabs.activate')
  expect(activation?.expectedEnvironmentPairingRevision).toBe(7)
})

it('sends owner activation when the pairing stays current through the lazy load', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
  activateTerminalTabOnOwner('repo::/sample', 'tab-1', 'leaf-1', 'env-1')

  await vi.waitFor(() =>
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: 'session.tabs.activate',
        expectedEnvironmentPairingRevision: 7
      })
    )
  )
})

it('sends nothing for a named owner with no known pairing at the click', async () => {
  activateTerminalTabOnOwner('repo::/sample', 'tab-1', 'leaf-1', 'env-1')
  replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 8 }])

  await vi.dynamicImportSettled()
  expect(sent).toEqual([])
})
