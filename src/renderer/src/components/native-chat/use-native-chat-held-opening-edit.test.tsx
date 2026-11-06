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
import { stageNativeChatDraftFile } from './native-chat-draft-attachment-staging'

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
      prepareFirstMessage: async () => {
        throw new Error('Attach the file again.')
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
    staged: { paths: ['/client/new.png'], prepare: expect.any(Function) }
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
