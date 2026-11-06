// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  draft,
  target
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchFailure,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { getStructuredAgentSessionSendNotice } from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import { requiredSetupLaunchFailureText } from '@/lib/required-setup-launch-failure'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import type {
  AgentLaunchReleasePhaseStatusResult,
  AgentLaunchStatusResult
} from '../../../../../shared/rpc-contract/agent-launch-accept-params'
import { renderHook } from '@testing-library/react'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import { forgetStructuredSessionSelection } from '../../structured-agent-session-selection-controller'
import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  AWAITING,
  CHAT_STARTED,
  HELD,
  IMAGE,
  MESSAGE_ID,
  OPERATION_ID,
  SAVED,
  SESSION_ID,
  SKILLS,
  SOURCE_SCOPE,
  host,
  hostAnswers,
  hostHistory,
  lifecycle,
  savedFirstTurn,
  seedCatalog,
  startHostLaunch,
  startReleaseLaunch,
  startRichReleaseLaunch,
  windowCalls,
  type HostLaunchPrepare
} from './structured-agent-session-host-launch.test-fixture'

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  host.accept.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  updateNativeChatComposerDraft(SOURCE_SCOPE, { text: 'Also run lint', images: [] }, 'immediate')
})
afterEach(() => cleanupCreateMessageFixture(restore))

describe('a chat its host launches after the workspace’s Setup', () => {
  it('adopts the host’s chat for the same session without sending its first message again', async () => {
    const status = deferred<AgentLaunchStatusResult>()
    host.status.mockResolvedValueOnce({ state: 'running' }).mockReturnValueOnce(status.promise)
    mocks.call.mockResolvedValue(hostHistory())
    const launch = startHostLaunch()
    expect(launch.sessionId).toBe(SESSION_ID)

    await vi.waitFor(() => expect(host.status).toHaveBeenCalledTimes(2))
    expect(lifecycle()).toBe('pending')
    expect(host.accept).toHaveBeenCalledOnce()
    expect(host.accept.mock.calls[0]![0]).toMatchObject({
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      target: { kind: 'existing' },
      nativeChatDefault: true,
      presentation: 'focused',
      // The chat founds the message under this window's own id, behind the creation's Setup run.
      prompt: { text: HELD, delivery: 'submit', clientMessageId: MESSAGE_ID },
      setupReceipt: { required: true, runId: 'setup-run-1' }
    })
    expect(host.accept.mock.calls[0]![0]).not.toHaveProperty('surface')
    // Each read is an ordinary bounded request.
    expect(host.status.mock.calls[0]).toEqual([
      { operationId: OPERATION_ID, waitMs: 20_000 },
      { timeoutMs: 25_000 }
    ])
    expect(windowCalls()).toEqual([
      'agent.launchAccept',
      'agent.launchStatus',
      'agent.launchStatus'
    ])

    status.resolve(CHAT_STARTED)
    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID, fence: 3 })
    await vi.waitFor(() => expect(lifecycle()).toBeNull())
    expect(windowCalls()).not.toContain('agentSession.create')
    expect(windowCalls()).not.toContain('agentSession.send')
    // The unsent draft moved into the chat; the first message is the host's, never handed back.
    expect(draft(SESSION_ID)).toBe('Also run lint')
  })

  it.each([
    [
      'Setup did not succeed',
      'agent_launch_setup_not_completed',
      () => requiredSetupLaunchFailureText('Codex')
    ],
    ['the chat was closed first', 'agent_launch_tab_closed', () => 'Chat could not be started.'],
    [
      'the host cannot run the chat and no terminal was planned',
      'agent_launch_surface_unavailable',
      // Names the agent once, with no second generic "could not be started" before it.
      () =>
        "Codex couldn't start. This workspace cannot run the chat. Check the agent installation or open it in a terminal."
    ]
  ])(
    'keeps the first message when %s, and starts nothing else',
    async (_case, code, noticeText) => {
      const status = deferred<AgentLaunchStatusResult>()
      host.status.mockReturnValue(status.promise)
      startHostLaunch()
      await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
      // A Setup past the send's own deadline is no reason to doubt the launch or hand text back.
      await vi.advanceTimersByTimeAsync(31_000)
      expect(lifecycle()).toBe('pending')
      expect(getStructuredAgentSessionSendNotice(SESSION_ID)).toBeNull()

      status.resolve({ state: 'failed', code })
      await vi.waitFor(() => expect(lifecycle()).toBe('failed'))
      expect(draft(SESSION_ID)).toContain(HELD)
      expect(draft(SESSION_ID)).toContain('Also run lint')
      expect(windowCalls()).toEqual(['agent.launchAccept', 'agent.launchStatus'])
      const notices = structuredSessionNotices({
        launch: {
          lifecycle: 'failed',
          failure: getStructuredAgentSessionLaunchFailure('workspace-1', SESSION_ID),
          retry: () => {}
        },
        agentLabel: 'Codex',
        sessionError: null,
        composerError: null
      })
      // One whole notice: what happened, what to do, and Retry.
      expect(notices).toEqual([
        {
          content: undefined,
          key: 'launch',
          kind: 'error',
          text: noticeText(),
          action: { label: 'Retry', onClick: expect.any(Function) }
        }
      ])
    }
  )

  it.each(['a reload', 'a lost status reply'])(
    'reads the same launch again after %s and never accepts it twice',
    async (loss) => {
      if (loss === 'a reload') {
        host.status.mockReturnValueOnce(new Promise(() => undefined))
        startHostLaunch()
        await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
        resetStructuredAgentLaunchRegistryForTests()
        resetStructuredAgentLaunchPersistenceForTests()
        expect(lifecycle()).toBe('visibility-unknown')
      } else {
        host.status.mockRejectedValue(new Error('runtime_unavailable'))
        startHostLaunch()
        await vi.advanceTimersByTimeAsync(5_000)
        await vi.waitFor(() => expect(lifecycle()).toBe('visibility-unknown'))
      }
      host.status.mockReset()
      host.status.mockResolvedValue(CHAT_STARTED)
      mocks.call.mockResolvedValue(hostHistory())

      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() => expect(lifecycle()).toBeNull())
      expect(host.accept).toHaveBeenCalledOnce()
      expect(host.status).toHaveBeenCalledWith(
        { operationId: OPERATION_ID, waitMs: 20_000 },
        { timeoutMs: 25_000 }
      )
      expect(windowCalls()).not.toContain('agentSession.create')
      if (loss === 'a reload') {
        // The host's chat holds the message, so no copy comes back.
        expect(draft(SESSION_ID)).not.toContain(HELD)
      }
    }
  )

  it.each([
    ['fails', { state: 'failed', code: 'agent_launch_setup_not_completed' }],
    ['cannot be confirmed', { state: 'unknown' }]
  ] as const)(
    'gives the held message back when, after a reload, the same launch %s, and sends nothing',
    async (_case, answer) => {
      host.status.mockReturnValueOnce(new Promise(() => undefined))
      startHostLaunch()
      await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
      // Saved beside the launch before the host answered, under the id the host was given.
      expect(localStorage.getItem('orca:structuredAgentLaunches:v1')).toContain(MESSAGE_ID)
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
      resetStructuredAgentSessionSendsForTests()
      host.status.mockReset()
      host.status.mockResolvedValue(answer)

      expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
      await vi.waitFor(() =>
        expect(lifecycle()).toBe(answer.state === 'failed' ? 'failed' : 'visibility-unknown')
      )
      expect(draft(SESSION_ID)).toContain(HELD)
      expect(draft(SESSION_ID)).toContain('Also run lint')
      expect(host.accept).toHaveBeenCalledOnce()
      expect(windowCalls()).not.toContain('agentSession.create')
      expect(windowCalls()).not.toContain('agentSession.send')
      // Given back once: the saved copy is gone, so another reload has nothing to repeat.
      expect(localStorage.getItem('orca:structuredAgentLaunches:v1') ?? '').not.toContain(
        MESSAGE_ID
      )
    }
  )
})

describe('the held message of a launch the host ran in a terminal', () => {
  const terminalStarted = (prompt: AgentLaunchResult['prompt']): AgentLaunchStatusResult => ({
    state: 'succeeded',
    result: {
      outcome: { kind: 'terminal', handle: 'term_1' },
      worktreeId: 'workspace-1',
      receipt: {
        mode: 'terminal',
        preferred: 'structured',
        reason: 'structured_unsupported_on_host',
        detail: ''
      },
      ...(prompt ? { prompt } : {})
    }
  })

  it.each([
    ['its submit was not delivered', { delivery: 'submit', outcome: 'not-delivered' }, true],
    ['it was left unsent there', { delivery: 'draft', outcome: 'not-delivered' }, true],
    ['its delivery is unconfirmed', { delivery: 'submit', outcome: 'unconfirmed' }, true],
    ['it was handed to the terminal', { delivery: 'submit', outcome: 'handed-to-terminal' }, false]
  ] as const)('is %s: back in the composer only without a receipt', async (_c, prompt, kept) => {
    host.status.mockResolvedValue(terminalStarted(prompt))
    const launch = startHostLaunch()
    await expect(launch.launchResult).rejects.toMatchObject({
      name: 'StructuredHostLaunchTerminalError'
    })
    if (kept) {
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(draft(SESSION_ID)).toContain(HELD)
    } else {
      expect(draft(SESSION_ID)).not.toContain(HELD)
    }
    expect(draft(SESSION_ID)).toContain('Also run lint')
    expect(windowCalls()).not.toContain('agentSession.send')
  })
})

describe('a chat whose host takes its first turn after Setup', () => {
  function reload(): void {
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentSessionSendsForTests()
    host.status.mockReset()
    host.release.mockReset()
  }

  beforeEach(() => {
    // A host new enough to take a release takes every input a send carries.
    mocks.exactSupport.mockResolvedValue(true)
    host.status.mockReset()
    host.release.mockReset()
    // A chat's picks outlive its launch in this window; each case starts with none.
    forgetStructuredSessionSelection(SESSION_ID)
    seedCatalog()
    host.prepare.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  })

  it('gives the host every pick made before Setup ended, once, and later picks to the next turn', async () => {
    const setup = deferred<AgentLaunchReleasePhaseStatusResult>()
    const firstTurn = deferred<AgentLaunchReleasePhaseStatusResult>()
    host.status.mockReturnValueOnce(setup.promise).mockReturnValueOnce(firstTurn.promise)
    const released = deferred<unknown>()
    host.release.mockReturnValue(released.promise)
    mocks.call.mockResolvedValue(hostHistory())
    const launch = startReleaseLaunch()
    const view = renderHook(() => useNativeChatProvisionalLaunch('workspace-1', SESSION_ID))

    await vi.waitFor(() => expect(host.status).toHaveBeenCalledOnce())
    // Prepared without choices, beside the terminal the host would plan for them.
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(host.prepare.mock.calls[0]![0]).toMatchObject({
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      // The message by its id only: its body goes with release, once its files are on the host.
      prompt: { delivery: 'submit', clientMessageId: MESSAGE_ID },
      setupReceipt: { required: true, runId: 'setup-run-1' },
      terminalAlternative: { kind: 'agent', prompt: 'none' }
    })
    for (const absent of ['terminalStartup', 'chatOptions', 'sessionOptions', 'prompt.text']) {
      expect(host.prepare.mock.calls[0]![0]).not.toHaveProperty(absent)
    }
    expect(host.status.mock.calls[0]![0]).toEqual({
      operationId: OPERATION_ID,
      waitMs: 20_000,
      includeReleasePhase: true
    })
    // What the chat shows is saved as the first turn still being edited, and nothing is released.
    expect(savedFirstTurn()).toMatchObject({ phase: 'editing' })
    expect(view.result.current.launch?.firstTurn).toBe('editing')
    expect(host.release).not.toHaveBeenCalled()

    // Picked while Setup runs, one of them while its readiness is already on the way.
    void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'picked-model')
    setup.resolve(AWAITING)
    void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    const input = host.release.mock.calls[0]![0]
    expect(input).toEqual({
      operationId: OPERATION_ID,
      options: expect.objectContaining({ model: 'picked-model', effort: 'high' }),
      selection: { model: 'picked-model', effort: 'high' },
      firstMessage: { clientMessageId: MESSAGE_ID, body: structuredAgentSessionSendBody(HELD, []) }
    })
    const {
      operationId: _id,
      firstMessage: _message,
      ...submitted
    } = input as Record<string, unknown>
    expect(savedFirstTurn()).toEqual({ phase: 'submitted', ...submitted })

    // The picker still takes a pick, now a choice for the next turn: it changes nothing sent.
    view.rerender()
    expect(view.result.current.launch?.firstTurn).toBe('submitted')
    expect(view.result.current.firstTurnSubmitted).toBe(true)
    expect(holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'low')).not.toBeNull()
    released.resolve({ operationId: OPERATION_ID, state: 'running' })
    firstTurn.resolve(CHAT_STARTED)
    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
    expect(host.release).toHaveBeenCalledOnce()
    // Only the later pick goes out, through the chat's own option path, for its next turn.
    await vi.waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        target,
        'agentSession.setOption',
        expect.objectContaining({ key: 'effort', value: 'low' }),
        expect.anything()
      )
    )
    const sentOptions = mocks.call.mock.calls.filter(
      ([, method]) => method === 'agentSession.setOption'
    )
    expect(sentOptions).toHaveLength(1)
    expect(windowCalls()).not.toContain('agentSession.create')
    expect(windowCalls()).not.toContain('agentSession.send')
  })

  it.each([
    ['text, an image and a skill', 'fix this $audit'],
    ['an image alone', '']
  ])(
    'releases %s whole once its files are on the host, with every pick made meanwhile',
    async (_case, text) => {
      host.status.mockResolvedValueOnce(AWAITING).mockResolvedValueOnce(CHAT_STARTED)
      const writes = vi.spyOn(localStorage, 'setItem')
      const savesBeforeRelease: number[] = []
      let saved: Record<string, unknown> | undefined
      host.release.mockImplementation(async () => {
        savesBeforeRelease.push(writes.mock.calls.filter(([key]) => key === SAVED).length)
        saved = JSON.parse(localStorage.getItem(SAVED) ?? '[]')[0]
        return { operationId: OPERATION_ID, state: 'running' }
      })
      mocks.call.mockResolvedValue(hostHistory())
      const uploading = deferred<StructuredAgentSessionFirstMessage['body']>()
      const prepareFirstMessage = vi.fn(
        (_operationId: string, _target: RuntimeClientTarget) => uploading.promise
      )
      const launch = startRichReleaseLaunch(text, prepareFirstMessage)
      void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'picked-model')

      await vi.waitFor(() => expect(prepareFirstMessage).toHaveBeenCalledOnce())
      expect(prepareFirstMessage).toHaveBeenCalledWith(OPERATION_ID, target)
      expect(savedFirstTurn()).toMatchObject({ phase: 'editing', staged: [IMAGE.path] })
      expect(host.release).not.toHaveBeenCalled()
      // Picked while the upload runs: still this first turn's.
      void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
      const onHost = structuredAgentSessionSendBody(
        text,
        [{ path: '/host/store/upload-1/shot.png', previewUri: '' }],
        SKILLS
      )
      writes.mockClear()
      uploading.resolve(onHost)

      await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
      expect(host.release.mock.calls[0]![0]).toEqual({
        operationId: OPERATION_ID,
        options: expect.objectContaining({ model: 'picked-model', effort: 'high' }),
        selection: { model: 'picked-model', effort: 'high' },
        firstMessage: { clientMessageId: MESSAGE_ID, body: onHost }
      })
      // The host-readable message and the submitted turn are saved together, in one write.
      expect(savesBeforeRelease).toEqual([1])
      expect(saved?.firstMessage).toEqual({ clientMessageId: MESSAGE_ID, body: onHost })
      expect(saved?.hostLaunchFirstTurn).toMatchObject({ phase: 'submitted' })
      expect(saved?.hostLaunchFirstTurn).not.toHaveProperty('staged')

      await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
      expect(windowCalls()).not.toContain('agentSession.create')
      expect(windowCalls()).not.toContain('agentSession.send')
      expect(draft(SESSION_ID)).toBe('Also run lint')
    }
  )

  it('keeps the message held under the same launch when a file cannot reach the host, until Retry', async () => {
    const onHost = structuredAgentSessionSendBody(
      'fix this $audit',
      [{ path: '/host/store/upload-1/shot.png', previewUri: '' }],
      SKILLS
    )
    const prepareFirstMessage = vi
      .fn<HostLaunchPrepare>()
      .mockRejectedValueOnce(new Error('Attach the file again.'))
      .mockResolvedValueOnce(onHost)
    // Ready for its input; then, while parked, a read that only ends with the launch.
    const parkedRead = deferred<AgentLaunchReleasePhaseStatusResult>()
    host.status.mockResolvedValueOnce(AWAITING).mockReturnValueOnce(parkedRead.promise)
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    mocks.call.mockResolvedValue(hostHistory())
    const launch = startRichReleaseLaunch('fix this $audit', prepareFirstMessage)
    const view = renderHook(() => useNativeChatProvisionalLaunch('workspace-1', SESSION_ID))

    await vi.waitFor(() => expect(host.status).toHaveBeenCalledTimes(2))
    expect(host.release).not.toHaveBeenCalled()
    // Shown as the existing not-started failure with its Retry, said once, not as a send notice.
    view.rerender()
    expect(view.result.current.lifecycle).toBe('failed')
    expect(view.result.current.failure).toEqual({
      kind: 'not-started',
      causeText: "Codex couldn't start. Couldn't attach shot.png. Attach the file again."
    })
    expect(getStructuredAgentSessionSendNotice(SESSION_ID)).toBeNull()
    const [notice] = structuredSessionNotices({
      launch: view.result.current,
      agentLabel: 'Codex',
      sessionError: null,
      composerError: null
    })
    expect(notice).toMatchObject({ key: 'launch', action: { label: 'Retry' } })
    // Still editing, its client message and owed file saved; nothing went back to the composer.
    expect(savedFirstTurn()).toMatchObject({ phase: 'editing', staged: [IMAGE.path] })
    // Only shown as failed: the saved row still reads a live launch, which a reload reads again.
    expect(JSON.parse(localStorage.getItem(SAVED) ?? '[]')[0]).toMatchObject({
      lifecycle: 'pending'
    })
    expect(draft(SESSION_ID)).not.toContain('fix this')
    // While parked it reads only whether the launch ended.
    expect(host.status.mock.calls[1]![0]).toEqual({ operationId: OPERATION_ID, waitMs: 20_000 })

    notice?.action?.onClick()
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    // The read Retry overtook is still the launch's one read, and it answers.
    parkedRead.resolve(CHAT_STARTED)
    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
    expect(host.status).toHaveBeenCalledTimes(2)
    expect(prepareFirstMessage).toHaveBeenCalledTimes(2)
    expect(host.release).toHaveBeenCalledOnce()
    expect(host.release.mock.calls[0]![0]).toMatchObject({
      operationId: OPERATION_ID,
      firstMessage: { clientMessageId: MESSAGE_ID, body: onHost }
    })
    expect(host.prepare).toHaveBeenCalledOnce()
  })

  it('gives the held message back whole only once its parked launch ends', async () => {
    host.status
      .mockResolvedValueOnce(AWAITING)
      .mockResolvedValueOnce({ state: 'failed', code: 'agent_launch_tab_closed' })
    const launch = startRichReleaseLaunch('fix this $audit', async () => {
      throw new Error('Attach the file again.')
    })
    await expect(launch.launchResult).rejects.toThrow()
    expect(host.release).not.toHaveBeenCalled()
    const back = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(SESSION_ID))
    expect(back.text).toContain('fix this $audit')
    expect(back.images.map(({ path }) => path)).toEqual([IMAGE.path])
    expect(windowCalls()).not.toContain('agentSession.send')
  })

  it('sends the same first turn again after a lost release reply, whatever was picked since', async () => {
    host.status
      .mockResolvedValueOnce(AWAITING)
      .mockResolvedValueOnce(AWAITING)
      .mockResolvedValueOnce(CHAT_STARTED)
    const lost = deferred<unknown>()
    host.release
      .mockReturnValueOnce(lost.promise)
      .mockResolvedValueOnce({ operationId: OPERATION_ID, state: 'running' })
    mocks.call.mockResolvedValue(hostHistory())
    void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'picked-model')
    const launch = startReleaseLaunch()
    void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'picked-model')
    await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
    void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'shown-model')
    lost.reject(new Error('runtime_unavailable'))
    await vi.advanceTimersByTimeAsync(500)

    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
    expect(host.release).toHaveBeenCalledTimes(2)
    expect(host.release.mock.calls[1]![0]).toEqual(host.release.mock.calls[0]![0])
    expect(host.release.mock.calls[0]![0]).toMatchObject({ selection: { model: 'picked-model' } })
    // One launch, one message id.
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(draft(SESSION_ID)).not.toContain(HELD)
  })

  it.each([
    ['still being edited', 'editing', 'released from what it showed'],
    ['already submitted', 'submitted', 'the same input sent again'],
    ['unreadable', 'unreadable', 'never released'],
    ['still being edited, then failed', 'failed', 'never released']
  ] as const)('after a reload, a first turn %s is %s', async (_case, saved, _outcome) => {
    if (saved === 'submitted') {
      host.status.mockResolvedValueOnce(AWAITING).mockReturnValue(new Promise(() => undefined))
      host.release.mockReturnValue(new Promise(() => undefined))
    } else {
      host.status.mockReturnValue(new Promise(() => undefined))
    }
    startReleaseLaunch()
    await vi.waitFor(() =>
      expect(saved === 'submitted' ? host.release : host.status).toHaveBeenCalledOnce()
    )
    const before = savedFirstTurn()
    const firstRelease = host.release.mock.calls[0]?.[0]
    if (saved === 'unreadable') {
      const rows: Record<string, unknown>[] = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
      localStorage.setItem(
        SAVED,
        JSON.stringify(rows.map((row) => ({ ...row, hostLaunchFirstTurn: { phase: 'chosen' } })))
      )
    }
    reload()
    host.status
      .mockResolvedValueOnce(
        saved === 'failed'
          ? { state: 'failed', code: 'agent_launch_setup_not_completed' }
          : AWAITING
      )
      .mockResolvedValue(CHAT_STARTED)
    host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    mocks.call.mockResolvedValue(hostHistory())

    if (saved === 'editing') {
      // Shown again from what it saved, and picked anew before the host is read.
      restorePersistedStructuredLaunchState('workspace-1', SESSION_ID)
      void holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    }
    expect(retryStructuredAgentSessionLaunch('workspace-1', SESSION_ID)).toBe(true)
    await vi.waitFor(() => expect(lifecycle()).not.toBe('pending'))
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(windowCalls()).not.toContain('agentSession.create')
    if (saved === 'editing') {
      // The shown choices it saved, not this machine's defaults of now.
      expect(before).toMatchObject({ phase: 'editing' })
      const shown = before as { selection: Record<string, string> }
      expect(host.release).toHaveBeenCalledOnce()
      expect(host.release.mock.calls[0]![0]).toMatchObject({
        operationId: OPERATION_ID,
        selection: { ...shown.selection, effort: 'high' }
      })
    } else if (saved === 'submitted') {
      expect(host.release).toHaveBeenCalledExactlyOnceWith(firstRelease)
    } else {
      expect(host.release).not.toHaveBeenCalled()
    }
    // A launch with no readable first turn never asks for a phase it could not answer.
    expect(host.status.mock.calls[0]![0]).toEqual({
      operationId: OPERATION_ID,
      waitMs: 20_000,
      ...(saved === 'unreadable' ? {} : { includeReleasePhase: true })
    })
    if (saved === 'failed') {
      expect(lifecycle()).toBe('failed')
      expect(draft(SESSION_ID)).toContain(HELD)
    }
  })
})
