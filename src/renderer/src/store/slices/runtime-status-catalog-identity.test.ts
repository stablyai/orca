import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  getRuntimeEnvironmentConnectionGeneration
} from './runtime-status'
import { createRuntimeStatusTestStore as createTestStore } from './runtime-status.test-fixture'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

// Nested endpoints expose broken reconciliation that scalar fixtures or Object.is-only fixes miss.
const pairingRevision = 1_700_000_000_000
const knownEndpoint: KnownRuntimeEnvironment['endpoints'][number] = {
  id: 'ws-a',
  kind: 'websocket',
  label: 'WebSocket',
  endpoint: 'wss://box.example:8787',
  deviceToken: 'device-token-a',
  publicKeyB64: 'public-key-a'
}
const knownEnvironment: KnownRuntimeEnvironment = {
  id: 'env-a',
  name: 'Dev Box',
  createdAt: pairingRevision,
  updatedAt: pairingRevision,
  pairingRevision,
  lastUsedAt: 1_700_000_100_000,
  runtimeId: 'runtime-a',
  source: 'manual',
  endpoints: [knownEndpoint],
  preferredEndpointId: 'ws-a'
}

function cloneRedactedCatalog(
  environment: KnownRuntimeEnvironment = knownEnvironment
): ReturnType<typeof redactRuntimeEnvironment>[] {
  return structuredClone([redactRuntimeEnvironment(environment)])
}

function makeStatus(): RuntimeStatus {
  return {
    runtimeId: 'rt',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  }
}

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setRuntimeEnvironments catalog identity', () => {
  it('keeps the array, row, and endpoints across independently cloned no-op lists', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    const previous = store.getState().runtimeEnvironments
    const second = cloneRedactedCatalog()
    expect(second).not.toBe(previous)
    expect(second[0]).not.toBe(previous[0])
    expect(second[0]?.endpoints).not.toBe(previous[0]?.endpoints)

    store.getState().setRuntimeEnvironments(second)
    const next = store.getState().runtimeEnvironments

    expect(next).toBe(previous)
    expect(next[0]).toBe(previous[0])
    expect(next[0]?.endpoints).toBe(previous[0]?.endpoints)
  })

  it('allocates a new row when an endpoint URL changes', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    const previous = store.getState().runtimeEnvironments

    store.getState().setRuntimeEnvironments(
      cloneRedactedCatalog({
        ...knownEnvironment,
        endpoints: [{ ...knownEndpoint, endpoint: 'wss://box.example:9999' }]
      })
    )

    const next = store.getState().runtimeEnvironments
    expect(next).not.toBe(previous)
    expect(next[0]).not.toBe(previous[0])
    expect(next[0]?.endpoints).not.toBe(previous[0]?.endpoints)
    expect(next[0]?.endpoints[0]?.endpoint).toBe('wss://box.example:9999')
  })

  it('still drops status and advances generation on a pairingRevision change', () => {
    const store = createTestStore()
    store.getState().setRuntimeEnvironments(cloneRedactedCatalog())
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    const before = getRuntimeEnvironmentConnectionGeneration('env-a')

    store
      .getState()
      .setRuntimeEnvironments(
        cloneRedactedCatalog({ ...knownEnvironment, pairingRevision: pairingRevision + 1 })
      )

    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(before + 1)
    expect(store.getState().runtimeEnvironments[0]?.pairingRevision).toBe(pairingRevision + 1)
  })
})

import * as launchDrafts from '@/components/native-chat/native-chat-composer-draft-store'
import * as pendingChips from '@/components/native-chat/native-chat-pending-attachment-cache'

it('runtime catalog replacement preserves ordinary setup drafts, preparation and other chat input', () => {
  launchDrafts.clearNativeChatComposerDraftsForTests()
  pendingChips.clearNativeChatPendingAttachmentsForTests()
  const store = createTestStore()
  const environment = { ...knownEnvironment, hostKeyFingerprint: 'same-peer' }
  store.getState().setRuntimeEnvironments(cloneRedactedCatalog(environment))
  const launch = launchDrafts.nativeChatLaunchPromptDraftScopeKey(
    'repo::/gone',
    'claude',
    'runtime:env-a'
  )
  const ssh = launchDrafts.nativeChatLaunchPromptDraftScopeKey('repo::/gone', 'claude', 'ssh:box')
  const other = launchDrafts.nativeChatLaunchPromptDraftScopeKey(
    'repo::/gone',
    'claude',
    'runtime:other'
  )
  const ordinary = launchDrafts.structuredAgentSessionDraftScopeKey('conversation')
  for (const key of [launch, ssh, other, ordinary]) {
    launchDrafts.updateNativeChatComposerDraft(
      key,
      { text: 'keep', owner: { workspaceId: 'repo::/gone', executionHostId: 'runtime:env-a' } },
      'immediate'
    )
  }
  const attempt = launchDrafts.captureNativeChatComposerSubmission(launch)
  pendingChips.addNativeChatPendingAttachment(launch, {
    id: 'runtime-chip',
    path: '',
    pending: true
  })
  store
    .getState()
    .setRuntimeEnvironmentStatus(
      'env-a',
      { status: null, checkedAt: 1 },
      { suppressDisconnectToast: true }
    )
  store
    .getState()
    .setRuntimeEnvironments(
      cloneRedactedCatalog({ ...environment, pairingRevision: pairingRevision + 1 })
    )
  expect(attempt.draft?.text).toBe('keep')
  store.getState().setRuntimeEnvironments(
    cloneRedactedCatalog({
      ...environment,
      pairingRevision: pairingRevision + 2,
      hostKeyFingerprint: 'different-peer'
    })
  )
  expect(attempt.draft?.text).toBe('keep')
  expect(pendingChips.nativeChatPendingAttachmentSnapshot(launch).map((chip) => chip.id)).toEqual([
    'runtime-chip'
  ])
  for (const key of [ssh, other, ordinary]) {
    expect(launchDrafts.readNativeChatComposerDraft(key).text).toBe('keep')
  }
  const newPeer = launchDrafts.nativeChatLaunchPromptDraftScopeKey(
    'repo::/gone',
    'claude',
    'runtime:env-a'
  )
  launchDrafts.updateNativeChatComposerDraft(newPeer, { text: 'new peer' }, 'immediate')
  expect(launchDrafts.readNativeChatComposerDraft(newPeer).text).toBe('new peer')
  store.getState().setRuntimeEnvironments([])
  expect(launchDrafts.readNativeChatComposerDraft(newPeer).text).toBe('new peer')
  launchDrafts.finishNativeChatComposerSubmission(launch, attempt)
  expect(launchDrafts.readNativeChatComposerDraft(newPeer).text).toBe('new peer')
  launchDrafts.clearNativeChatComposerDraftsForTests()
})
