// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.call(target, method, params),
  structuredAgentSessionHostSupports: vi.fn(async () => true)
}))

import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal,
  stopStructuredAgentSessionSends
} from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  subscribeToStructuredAgentSessionPendingSends
} from '@/components/native-chat/structured-agent-session-pending-sends'
import {
  captureNativeChatStagedInput,
  releaseNativeChatStagedFiles,
  stageNativeChatDraftFile
} from '@/components/native-chat/native-chat-draft-attachment-staging'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
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

  it('sends the prompt once after the launch publishes, under its receipt fence', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const onPromptDelivered = vi.fn()

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 7 }),
        target,
        options: { prompt: 'review this', onPromptDelivered },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(onPromptDelivered).toHaveBeenCalledOnce()
    // The receipt's fence is known, so no history read precedes the send.
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.send'])
    expect(sends()[0]?.[2]).toMatchObject({
      envelope: { sessionId: SESSION, expectedRuntimeFence: 7 },
      body: { blocks: [{ type: 'text', text: 'review this' }] }
    })
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it.each([
    {
      name: 'an image-only first message',
      text: '',
      skills: undefined,
      blocks: [{ type: 'image-ref', path: '/client/paste.png' }]
    },
    {
      name: 'a first message with an image and a selected skill',
      text: 'review $audit',
      skills: [{ name: 'audit', path: '/repo/.agents/skills/audit/SKILL.md' }],
      blocks: [
        { type: 'text', text: 'review $audit' },
        { type: 'image-ref', path: '/client/paste.png' }
      ]
    }
  ])('sends $name without losing its rich input', async ({ text, skills, blocks }) => {
    const attachments = [{ path: '/client/paste.png', previewUri: '' }]
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, text, { attachments, skills })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: text, promptAttachments: attachments, promptSkills: skills },
        stagedPrompt
      })
    ).resolves.toMatchObject({ delivered: true })

    expect(sends()).toHaveLength(1)
    expect(sends()[0]?.[2]).toMatchObject({
      body: { kind: 'message', role: 'user', blocks, ...(skills ? { skills } : {}) }
    })
    expect(draft()).toBe('')
  })

  it('uploads staged files before sending their host paths and selected skills', async () => {
    const remoteTarget = { kind: 'environment', environmentId: 'env-1' } as const
    const attachments = [{ path: '/client/paste.png', previewUri: '' }]
    const skills = [{ name: 'audit', path: '/repo/.agents/skills/audit/SKILL.md' }]
    const text = 'review $audit with @"/client/brief notes.txt"'
    stageNativeChatDraftFile(STAGING_SCOPE, '/client/paste.png')
    stageNativeChatDraftFile(STAGING_SCOPE, '/client/brief notes.txt')
    const preparation = captureNativeChatStagedInput(STAGING_SCOPE)
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
    const upload = vi.fn(async () => ({
      uploaded: [
        { sourcePath: '/client/paste.png', path: '/host/attachments/paste.png' },
        { sourcePath: '/client/brief notes.txt', path: '/host/attachments/brief notes.txt' }
      ],
      skipped: [],
      failed: []
    }))
    vi.stubGlobal('api', { fs: { uploadPathsToAgentSessionAttachments: upload } })
    mocks.call.mockImplementation(async (_target, method, params) =>
      method === 'status.get'
        ? { runtimeId: 'runtime-1', capabilities: [AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY] }
        : accepted(params.envelope.clientOperationId)
    )
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, text, {
      attachments,
      skills,
      prepare: (sessionId, destination) =>
        preparation.prepare(
          { text, attachments, skills },
          {
            sessionId,
            runtimeEnvironmentId:
              destination.kind === 'environment' ? destination.environmentId : null
          }
        )
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target: remoteTarget,
        options: { prompt: text, promptAttachments: attachments, promptSkills: skills },
        stagedPrompt
      })
    ).resolves.toMatchObject({ delivered: true })

    expect(upload).toHaveBeenCalledOnce()
    expect(upload).toHaveBeenCalledWith({
      paths: ['/client/paste.png', '/client/brief notes.txt'],
      environmentId: 'env-1',
      sessionId: SESSION,
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-1'
    })
    expect(sends()).toHaveLength(1)
    expect(sends()[0]?.[2]).toMatchObject({
      body: {
        blocks: [
          { type: 'text', text: 'review $audit with @"/host/attachments/brief notes.txt"' },
          { type: 'image-ref', path: '/host/attachments/paste.png' }
        ],
        skills
      }
    })
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

  it('shares one send between every caller waiting on the same staged prompt', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const launchResult = Promise.resolve({ sessionId: SESSION, fence: 1 })
    const settle = () =>
      settleStructuredAgentLaunchPrompt({
        launchResult,
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })

    const results = await Promise.all([settle(), settle()])

    expect(results).toEqual([
      { delivered: true, failureNotified: false },
      { delivered: true, failureNotified: false }
    ])
    expect(sends()).toHaveLength(1)
  })

  it("puts the prompt in the chat's composer when the launch fails, and preserves that ownership result", async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const failure = new Error('create refused')

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(failure),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toMatchObject({ delivered: false, failureNotified: true, inComposer: true })

    expect(draft()).toBe('review this')
    expect(sends()).toHaveLength(0)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('neither sends nor gives back a prompt whose launch was cancelled', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    discardStructuredLaunchPrompts(SESSION)

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toMatchObject({ delivered: false, failureNotified: true })
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(new Error('cancelled')),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toMatchObject({ delivered: false, failureNotified: true })

    expect(sends()).toHaveLength(0)
    expect(draft()).toBe('')
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

  it('reports a prompt the host refused as not delivered, with its text back in the composer', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const onPromptDelivered = vi.fn()
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this', onPromptDelivered },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false, inComposer: true })

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(draft()).toBe('review this')
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

  // Once sent, the prompt's entry is the sender's: what it keeps after settling stays.
  it('leaves in the chat a launch prompt the host recorded and a Stop then withdrew', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const answer = accepted(params.envelope.clientOperationId)
      answer.value.submission.dispatchState = 'pending'
      return answer
    })
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })
    const promptId: string = mocks.call.mock.calls.find(
      ([, method]) => method === 'agentSession.send'
    )?.[2].envelope.clientOperationId

    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [
        {
          clientMessageId: promptId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: null,
          rejection: { kind: 'cancelled' },
          submittedAt: 1,
          resolvedAt: 2
        }
      ],
      []
    )
    // The host's row draws it, with its stop row; the composer is left alone.
    expect(draft()).toBe('')
    expect(pendingTexts()).toEqual([])
  })

  it("keeps an open chat drawing its launch prompt until the prompt's row arrives", async () => {
    const stop = subscribeToStructuredAgentSessionPendingSends(SESSION, () => {})
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(pendingTexts()).toEqual(['review this:recorded'])
    stop()
  })
})
