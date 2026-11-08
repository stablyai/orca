// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.call(target, method, params)
}))

vi.mock(
  '../../../runtime/native-chat/host-capabilities/structured-agent-session-host-support',
  () => ({
    structuredAgentSessionHostSupports: vi.fn(async () => true)
  })
)

import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  stopStructuredAgentSessionSends
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { clearNativeChatComposerDraftsForTests as clearNativeChatDraftCacheForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import { readNativeChatDraftCache } from '@/components/native-chat/drafts/native-chat-draft-views'
import { readNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { releaseNativeChatStagedFiles } from '@/components/native-chat/drafts/native-chat-draft-attachment-staging'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt,
  settleStructuredAgentLaunchPrompt,
  stageStructuredLaunchPrompt,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'

const SESSION = 'session-1'
const STAGING_SCOPE = 'pending-launch-attachments'
const target = { kind: 'local' } as const

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    }
  }
}

function sends(): unknown[][] {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

function pendingTexts(): string[] {
  return getStructuredAgentSessionPendingSends(SESSION).map(
    (entry) =>
      `${entry.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')}:${entry.phase}`
  )
}

function draft(): string {
  return readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))
}

function launchWaitingForAttachments() {
  const input = {
    text: 'review the screenshot',
    attachments: [{ path: '/client/paste.png', previewUri: '' }]
  }
  const upload = Promise.withResolvers<typeof input>()
  const preparing = Promise.withResolvers<void>()
  const stagedPrompt = stageStructuredLaunchPrompt(SESSION, input.text, {
    attachments: input.attachments,
    prepare: () => {
      preparing.resolve()
      return upload.promise
    }
  })
  const settled = settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
    target,
    options: { prompt: input.text, promptAttachments: input.attachments },
    stagedPrompt
  })
  return { input, upload, preparing: preparing.promise, stagedPrompt, settled }
}

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    discardStructuredLaunchPrompts(SESSION)
    mocks.call.mockImplementation(async (_target, _method, params) =>
      accepted(params.envelope.clientOperationId)
    )
  })

  afterEach(() => {
    releaseNativeChatStagedFiles(STAGING_SCOPE)
    replaceRuntimeEnvironmentRevisions([])
    vi.unstubAllGlobals()
  })

  it('returns rich input on Stop during upload and never sends it after upload completes', async () => {
    const launch = launchWaitingForAttachments()
    await launch.preparing

    stopStructuredAgentSessionSends(SESSION)
    launch.upload.resolve({
      ...launch.input,
      attachments: [{ path: '/host/attachments/paste.png', previewUri: '' }]
    })
    await Promise.all([launch.settled, launch.stagedPrompt.delivery])

    expect(sends()).toHaveLength(0)
    expect(draft()).toBe('review the screenshot')
    expect(
      readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(SESSION)).images
    ).toMatchObject([{ path: '/client/paste.png' }])
    expect(pendingTexts()).toEqual([])
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('does not restore closed chat input or a notice when its pending upload rejects', async () => {
    const launch = launchWaitingForAttachments()
    await launch.preparing

    discardStructuredLaunchPrompts(SESSION)
    launch.upload.reject(new Error('upload interrupted'))
    await Promise.all([launch.settled, launch.stagedPrompt.delivery])

    expect(sends()).toHaveLength(0)
    expect(draft()).toBe('')
    expect(
      readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(SESSION)).images
    ).toEqual([])
    expect(getStructuredAgentSessionSendNotice(SESSION)).toBeNull()
    expect(pendingTexts()).toEqual([])
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('gives a Stop before the chat is published its prompt back, and never sends it', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    let publish: (receipt: { sessionId: string; fence: number }) => void = () => {}
    const settled = settleStructuredAgentLaunchPrompt({
      launchResult: new Promise((resolve) => {
        publish = resolve
      }),
      target,
      options: { prompt: 'review this' },
      stagedPrompt
    })
    expect(pendingTexts()).toEqual(['review this:sending'])

    takeBackLegacyStructuredLaunchPrompts(SESSION)
    publish({ sessionId: SESSION, fence: 1 })

    await expect(settled).resolves.toMatchObject({ delivered: false, failureNotified: true })
    expect(draft()).toBe('review this')
    expect(pendingTexts()).toEqual([])
    expect(sends()).toHaveLength(0)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  // Reserve the first-message slot from click through creation; later typed text must never overtake launch input.
  it('holds the chat for its prompt from the click, then sends that prompt first, once', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    expect(pendingTexts()).toEqual(['review this:sending'])
    expect(
      sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'typed meanwhile' })
    ).toBeNull()
    expect(sends()).toHaveLength(0)

    let receive = (_receipt: { sessionId: string; fence: number }): void => {}
    const settled = settleStructuredAgentLaunchPrompt({
      launchResult: new Promise((resolve) => (receive = resolve)),
      target,
      options: { prompt: 'review this' },
      stagedPrompt
    })
    receive({ sessionId: SESSION, fence: 1 })
    await expect(settled).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(sends()).toHaveLength(1)
    expect(JSON.stringify(sends()[0])).toContain('review this')
    expect(
      sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'typed after' })
    ).not.toBeNull()
  })
})
