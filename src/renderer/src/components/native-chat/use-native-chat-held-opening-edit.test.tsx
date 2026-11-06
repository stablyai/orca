// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred
} from '@/lib/structured-agent-session-launch-create-message.test-fixture'
import {
  AWAITING,
  CHAT_STARTED,
  IMAGE,
  MESSAGE_ID,
  OPERATION_ID,
  SESSION_ID,
  SKILLS,
  SOURCE_SCOPE,
  host,
  hostAnswers,
  hostHistory,
  savedFirstTurn,
  windowCalls
} from '@/lib/agent-session/launch/structured-agent-session-host-launch.test-fixture'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { replaceHeldHostLaunchOpening } from '@/lib/agent-session/launch/structured-agent-session-host-launch-opening-edit'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { structuredAgentSessionSendBody } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentLaunchReleasePhaseStatusResult } from '../../../../shared/rpc-contract/agent-launch-accept-params'
import type * as OpeningEdit from '@/lib/agent-session/launch/structured-agent-session-host-launch-opening-edit'
import type * as AttachmentUpload from './native-chat-attachment-upload'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  captureNativeChatStagedInput,
  hasNativeChatStagedFiles,
  stageNativeChatDraftFile
} from './native-chat-draft-attachment-staging'
import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile
} from '@/lib/browser-attachment-files'
import { leasedHostLaunchSources } from '@/lib/agent-session/launch/structured-agent-session-host-launch-sources'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'

vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-host-launch-opening-edit',
  async (importOriginal) => {
    const actual = await importOriginal<typeof OpeningEdit>()
    return { ...actual, replaceHeldHostLaunchOpening: vi.fn(actual.replaceHeldHostLaunchOpening) }
  }
)
// The paired host's chat store, at the upload boundary.
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof AttachmentUpload>()),
  resolveNativeChatRuntimeSessionAttachmentOwner: () => ({
    kind: 'runtime-session',
    environmentId: 'server-1',
    pairingRevision: 1,
    sessionId: SESSION_ID
  }),
  prepareNativeChatSessionAttachmentUpload: async () => ({
    ok: true,
    target: { environmentId: 'server-1', sessionId: SESSION_ID }
  }),
  uploadNativeChatSessionAttachmentPaths: async (paths: string[]) => ({
    uploaded: paths.map((sourcePath) => ({
      sourcePath,
      path: `/host/store/${sourcePath.split('/').at(-1)}`
    })),
    skipped: [],
    failed: []
  })
}))

const TEXT = 'fix this $audit'
const DRAFT_A = structuredAgentSessionDraftScopeKey(SESSION_ID)
let restore: (() => void) | undefined
let parkedRead: ReturnType<typeof deferred<AgentLaunchReleasePhaseStatusResult>>

beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  host.prepare.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  host.release.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
  mocks.call.mockResolvedValue(hostHistory())
  parkedRead = deferred<AgentLaunchReleasePhaseStatusResult>()
  host.status.mockResolvedValueOnce(AWAITING).mockReturnValueOnce(parkedRead.promise)
  updateNativeChatComposerDraft(SOURCE_SCOPE, { text: 'Also run lint', images: [] }, 'immediate')
  // The client file the held opening owes its paired host is gone.
  Object.assign(window, { api: { fs: { pathExists: async () => false } } })
})
afterEach(() => {
  cleanup()
  cleanupCreateMessageFixture(restore)
})

/** A paired host's held launch whose image never reached it: parked with its notice. */
async function parkedPairedLaunch() {
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'runtime:server-1',
    prompt: TEXT,
    promptAttachments: [IMAGE],
    promptSkills: SKILLS,
    draftFromScope: SOURCE_SCOPE,
    hostLaunch: {
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      protocol: 'release',
      opening: {
        clientMessageId: MESSAGE_ID,
        body: structuredAgentSessionSendBody(TEXT, [IMAGE], SKILLS)
      },
      stagedSources: [IMAGE.path],
      sources: {
        prepare: async () => {
          throw new Error('Attach the file again.')
        },
        release: () => {}
      },
      accept: {
        presentation: 'focused',
        setupReceipt: { required: true, runId: 'setup-run-1' },
        terminalAlternative: { kind: 'none' }
      }
    }
  })
  const view = renderHook(() => useNativeChatProvisionalLaunch('workspace-1', SESSION_ID))
  await vi.waitFor(() => expect(host.status).toHaveBeenCalledTimes(2))
  view.rerender()
  expect(view.result.current.lifecycle).toBe('failed')
  render(
    <NativeChatComposerNotices
      notices={structuredSessionNotices({
        launch: view.result.current,
        agentLabel: 'Codex',
        sessionError: null,
        composerError: null
      })}
    />
  )
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  act(() => fireEvent.click(screen.getByRole('button', { name: 'Edit' })))
  const editing = view.result.current.openingEdit!
  // The held opening, seeded into the edit's own draft; its gone image asks to be attached again.
  await vi.waitFor(() =>
    expect(readNativeChatComposerDraft(editing.draftScopeKey).images).toEqual([
      { id: 'kept-1', path: '', unavailableName: 'shot.png' }
    ])
  )
  expect(readNativeChatComposerDraft(editing.draftScopeKey).text).toBe(TEXT)
  expect(view.result.current.openingEdit?.editSession.canSave).toBe(false)
  return { launch, view, scope: editing.draftScopeKey }
}

it('saves an edited opening whose image is gone under the same message and launch', async () => {
  const { launch, view, scope } = await parkedPairedLaunch()
  // Remove the gone image and attach a replacement, as the composer's chips do.
  act(() => {
    stageNativeChatDraftFile(scope, '/client/new.png')
    updateNativeChatComposerDraft(
      scope,
      { images: [{ id: 'added', path: '/client/new.png' }] },
      'immediate'
    )
  })
  expect(view.result.current.openingEdit?.editSession.canSave).toBe(true)
  act(() => view.result.current.openingEdit!.editSession.save())

  const edited = structuredAgentSessionSendBody(
    TEXT,
    [{ path: '/client/new.png', previewUri: '' }],
    SKILLS
  )
  expect(replaceHeldHostLaunchOpening).toHaveBeenCalledExactlyOnceWith('workspace-1', SESSION_ID, {
    body: edited,
    staged: {
      paths: ['/client/new.png'],
      sources: expect.objectContaining({ release: expect.any(Function) })
    }
  })
  expect(view.result.current.openingEdit).toBeNull()
  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: '', images: [] })
  // The launch finishes by itself: one release of the same message, its file now on the host.
  await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
  expect(host.release.mock.calls[0]![0]).toMatchObject({
    operationId: OPERATION_ID,
    firstMessage: {
      clientMessageId: MESSAGE_ID,
      body: structuredAgentSessionSendBody(
        TEXT,
        [{ path: '/host/store/new.png', previewUri: '' }],
        SKILLS
      )
    }
  })
  parkedRead.resolve(CHAT_STARTED)
  await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
  // The chat's own draft was never read into the edit, changed or sent.
  expect(readNativeChatComposerDraft(DRAFT_A)).toMatchObject({ text: 'Also run lint', images: [] })
  expect(windowCalls()).not.toContain('agentSession.send')
  expect(windowCalls()).not.toContain('agentSession.create')
})

it('cancels an edit leaving the launch parked with Retry and the chat draft as it was', async () => {
  const { view, scope } = await parkedPairedLaunch()
  act(() => view.result.current.openingEdit!.editSession.cancel())

  expect(view.result.current.openingEdit).toBeNull()
  expect(readNativeChatComposerDraft(scope)).toMatchObject({ text: '', images: [] })
  expect(replaceHeldHostLaunchOpening).not.toHaveBeenCalled()
  expect(view.result.current.lifecycle).toBe('failed')
  expect(view.result.current.editOpening).toEqual({ open: expect.any(Function) })
  expect(savedFirstTurn()).toMatchObject({ phase: 'editing', staged: [IMAGE.path] })
  expect(host.release).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(DRAFT_A)).toMatchObject({ text: 'Also run lint', images: [] })
})

it('gives back the edited opening, never the original, when the host then refuses it', async () => {
  const { launch, view, scope } = await parkedPairedLaunch()
  act(() => {
    stageNativeChatDraftFile(scope, '/client/replacement.png')
    updateNativeChatComposerDraft(
      scope,
      { text: 'Edited request $audit', images: [{ id: 'new', path: '/client/replacement.png' }] },
      'immediate'
    )
  })
  act(() => view.result.current.openingEdit!.editSession.save())
  await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
  const edited = structuredAgentSessionSendBody(
    'Edited request $audit',
    [{ path: '/host/store/replacement.png', previewUri: '' }],
    SKILLS
  )
  expect(host.release.mock.calls[0]![0]).toMatchObject({
    operationId: OPERATION_ID,
    firstMessage: { clientMessageId: MESSAGE_ID, body: edited }
  })

  // The chat already exists on the host: the edited message comes back whole, beside A.
  parkedRead.resolve({ state: 'failed', code: 'agent_launch_session_already_exists' })
  await launch.launchResult.catch(() => undefined)
  await act(async () => {})
  const back = readNativeChatComposerDraft(DRAFT_A)
  expect(back.text).toContain('Also run lint')
  expect(back.text).toContain('Edited request $audit')
  expect(back.text).not.toContain('fix this')
  expect(back.images.map(({ path }) => path)).toEqual(['/host/store/replacement.png'])
  expect(windowCalls()).not.toContain('agentSession.send')
  expect(windowCalls()).not.toContain('agentSession.create')
})

it.each([3, 30])(
  'holds no replacement File or edit scope once %i edited openings are released and received',
  async (count) => {
    const held: { token: string; scope: string }[] = []
    for (let cycle = 0; cycle < count; cycle++) {
      if (cycle > 0) {
        cleanup()
        resetStructuredAgentLaunchRegistryForTests()
        resetStructuredAgentLaunchPersistenceForTests()
        parkedRead = deferred<AgentLaunchReleasePhaseStatusResult>()
        host.status.mockReset()
        host.release.mockClear()
        host.status.mockResolvedValueOnce(AWAITING).mockReturnValueOnce(parkedRead.promise)
      }
      const { launch, view, scope } = await parkedPairedLaunch()
      const [token] = holdBrowserAttachmentFiles([
        new File([new Uint8Array(1024)], `new-${cycle}.png`, { type: 'image/png' })
      ])
      act(() => {
        stageNativeChatDraftFile(scope, token!)
        updateNativeChatComposerDraft(
          scope,
          { images: [{ id: 'added', path: token! }] },
          'immediate'
        )
      })
      act(() => view.result.current.openingEdit!.editSession.save())
      await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
      parkedRead.resolve(CHAT_STARTED)
      await expect(launch.launchResult).resolves.toMatchObject({ sessionId: SESSION_ID })
      view.unmount()
      held.push({ token: token!, scope })
    }
    // Each edit's file went to the host with its submitted first turn; nothing keeps it after.
    expect(held.filter(({ token }) => readBrowserAttachmentFile(token) !== null)).toEqual([])
    expect(held.filter(({ scope }) => hasNativeChatStagedFiles(scope))).toEqual([])
  }
)

it('gives a file not yet sent back with its message, still usable from the chat draft', async () => {
  host.status.mockReset()
  host.status.mockResolvedValue({ state: 'failed', code: 'agent_launch_tab_closed' })
  const source = 'pending-worktree-creation:creation-file'
  const [token] = holdBrowserAttachmentFiles([
    new File(['bytes'], 'held.png', { type: 'image/png' })
  ])
  stageNativeChatDraftFile(source, token!)
  const image = { path: token!, previewUri: '' }
  const lease = captureNativeChatStagedInput(source, { text: TEXT, attachments: [image] })
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'runtime:server-1',
    prompt: TEXT,
    promptAttachments: [image],
    hostLaunch: {
      operationId: OPERATION_ID,
      sessionId: SESSION_ID,
      protocol: 'release',
      opening: {
        clientMessageId: MESSAGE_ID,
        body: structuredAgentSessionSendBody(TEXT, [image], SKILLS)
      },
      stagedSources: [token!],
      sources: leasedHostLaunchSources(lease, SESSION_ID),
      accept: {
        presentation: 'focused',
        setupReceipt: { required: true, runId: 'setup-run-1' },
        terminalAlternative: { kind: 'none' }
      }
    }
  })
  await launch.launchResult.catch(() => undefined)
  // The launch ended before the file was sent: it comes back with the text, and the chat's draft
  // now holds the file the composer can send.
  const back = readNativeChatComposerDraft(DRAFT_A)
  expect(back.text).toContain(TEXT)
  expect(back.images.map(({ path }) => path)).toEqual([token])
  expect(readBrowserAttachmentFile(token!)).not.toBeNull()
  expect(hasNativeChatStagedFiles(DRAFT_A)).toBe(true)
  expect(hasNativeChatStagedFiles(source)).toBe(false)
  expect(host.release).not.toHaveBeenCalled()
})
