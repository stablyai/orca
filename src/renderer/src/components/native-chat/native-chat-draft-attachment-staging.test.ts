// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile
} from '@/lib/browser-attachment-files'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { useAppStore } from '@/store'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import {
  clearNativeChatComposerDraftsForTests,
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import { moveNativeChatComposerDraft } from './native-chat-composer-draft-move'
import {
  captureNativeChatStagedInput,
  holdNativeChatStagedInput,
  releaseNativeChatStagedFiles,
  stageNativeChatDraftFile
} from './native-chat-draft-attachment-staging'

const uploadPaths = vi.fn<Window['api']['fs']['uploadPathsToAgentSessionAttachments']>()
const statusCall = vi.fn<Window['api']['runtimeEnvironments']['call']>()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const session = { sessionId: 'session', runtimeEnvironmentId: 'server' }
const initialStore = useAppStore.getState()

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 1, pairingRevision: 7 }])
  uploadPaths.mockReset()
  statusCall.mockReset().mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'runtime',
      capabilities: [AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY]
    },
    _meta: { runtimeId: 'runtime' }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: { uploadPathsToAgentSessionAttachments: uploadPaths },
      runtimeEnvironments: { call: statusCall }
    }
  })
})

afterEach(() => {
  for (const scope of ['pending', 'destination', 'pending-worktree-creation:creation']) {
    releaseNativeChatStagedFiles(scope)
  }
  useAppStore.setState(initialStore, true)
  clearNativeChatComposerDraftsForTests()
  replaceRuntimeEnvironmentRevisions([])
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('uploads staged images and pasted files to the session host before returning their references', async () => {
  stageNativeChatDraftFile('pending', '/client/screen.png')
  stageNativeChatDraftFile('pending', '/client/pasted text.txt')
  stageNativeChatDraftFile('pending', '/client/removed.png')
  uploadPaths.mockResolvedValue({
    uploaded: [
      { sourcePath: '/client/screen.png', path: '/host/agent-session-attachments/image.png' },
      { sourcePath: '/client/pasted text.txt', path: '/host/agent-session-attachments/text.txt' }
    ],
    failed: [],
    skipped: []
  })

  const prepared = await captureNativeChatStagedInput('pending').prepare(
    {
      text: 'Read @"/client/pasted text.txt" with @/client/screen.png and @/host/existing.md',
      attachments: [{ id: 'image', path: '/client/screen.png' }]
    },
    session
  )

  expect(prepared).toEqual({
    text: 'Read @/host/agent-session-attachments/text.txt with @/host/agent-session-attachments/image.png and @/host/existing.md',
    attachments: [{ id: 'image', path: '/host/agent-session-attachments/image.png' }]
  })
  expect(uploadPaths).toHaveBeenCalledExactlyOnceWith({
    environmentId: 'server',
    sessionId: 'session',
    expectedEnvironmentPairingRevision: 7,
    expectedEnvironmentRuntimeId: 'runtime',
    paths: ['/client/screen.png', '/client/pasted text.txt']
  })
})

it('retains successful uploads when another staged file fails so retry sends only the failed file', async () => {
  stageNativeChatDraftFile('pending', '/client/screen.png')
  stageNativeChatDraftFile('pending', '/client/context.txt')
  uploadPaths
    .mockResolvedValueOnce({
      uploaded: [
        { sourcePath: '/client/screen.png', path: '/host/agent-session-attachments/image.png' }
      ],
      failed: [{ sourcePath: '/client/context.txt', reason: 'Host disconnected' }],
      skipped: []
    })
    .mockResolvedValueOnce({
      uploaded: [
        { sourcePath: '/client/context.txt', path: '/host/agent-session-attachments/context.txt' }
      ],
      failed: [],
      skipped: []
    })
  const submission = captureNativeChatStagedInput('pending')
  const input = {
    text: 'Use @/client/context.txt',
    attachments: [{ path: '/client/screen.png' }]
  }

  await expect(submission.prepare(input, session)).rejects.toThrow('Host disconnected')
  const prepared = await submission.prepare(input, session)

  expect(uploadPaths.mock.calls.map(([args]) => args.paths)).toEqual([
    ['/client/screen.png', '/client/context.txt'],
    ['/client/context.txt']
  ])
  expect(prepared).toEqual({
    text: 'Use @/host/agent-session-attachments/context.txt',
    attachments: [{ path: '/host/agent-session-attachments/image.png' }]
  })
})

it.each([false, true])(
  'keeps browser files through a draft handoff, including an early handback: %s',
  (returned) => {
    const screen = new File(['screen'], 'screen.png', { type: 'image/png' })
    const later = new File(['later'], 'later.png', { type: 'image/png' })
    const [screenPath, laterPath] = holdBrowserAttachmentFiles([screen, later])
    stageNativeChatDraftFile('pending', screenPath)
    stageNativeChatDraftFile('pending', laterPath)
    updateNativeChatComposerDraft(
      'pending',
      {
        text: 'Review these',
        images: [
          { id: 'screen', path: screenPath },
          { id: 'later', path: laterPath }
        ]
      },
      'immediate'
    )
    const submission = captureNativeChatStagedInput('pending')
    if (returned) {
      const draft = readNativeChatComposerDraft('pending')
      updateNativeChatComposerDraft('pending', { text: '', images: [] }, 'immediate')
      updateNativeChatComposerDraft('destination', draft, 'immediate')
    }

    moveNativeChatComposerDraft('pending', 'destination')
    if (returned) {
      submission.release()
    }

    expect(readNativeChatComposerDraft('destination').images.map(({ path }) => path)).toEqual([
      screenPath,
      laterPath
    ])
    expect(readBrowserAttachmentFile(screenPath)).toBe(screen)
    expect(readBrowserAttachmentFile(laterPath)).toBe(later)
    updateNativeChatComposerDraft(
      'destination',
      { images: [{ id: 'later', path: laterPath }] },
      'immediate'
    )
    submission.release({ text: '', attachments: [{ path: screenPath }] })
    expect(readBrowserAttachmentFile(screenPath)).toBeNull()
    expect(readBrowserAttachmentFile(laterPath)).toBe(later)

    deleteNativeChatComposerDraft('destination')

    expect(readBrowserAttachmentFile(laterPath)).toBeNull()
  }
)

it('releases browser files removed from images, file references, and pasted text', () => {
  const paths = holdBrowserAttachmentFiles([
    new File(['image'], 'screen.png', { type: 'image/png' }),
    new File(['file'], 'context.txt', { type: 'text/plain' }),
    new File(['paste'], 'pasted.txt', { type: 'text/plain' })
  ])
  const pasteId = '11111111-1111-1111-1111-111111111111'
  stageNativeChatDraftFile('pending', paths[0])
  updateNativeChatComposerDraft(
    'pending',
    { images: [{ id: 'screen', path: paths[0] }] },
    'immediate'
  )
  updateNativeChatComposerDraft(
    'pending',
    {
      text: `@${paths[1]} [Pasted text](orca-paste:${pasteId})`,
      images: [{ id: 'screen', path: paths[0] }],
      pastedTextFiles: { [pasteId]: paths[2] }
    },
    'immediate'
  )
  paths.slice(1).forEach((path) => stageNativeChatDraftFile('pending', path))
  updateNativeChatComposerDraft('pending', { images: [] }, 'immediate')
  expect(readBrowserAttachmentFile(paths[0])).toBeNull()
  expect(paths.slice(1).map(readBrowserAttachmentFile).every(Boolean)).toBe(true)

  updateNativeChatComposerDraft('pending', { text: '', images: [] }, 'immediate')

  expect(paths.map(readBrowserAttachmentFile)).toEqual([null, null, null])
})

it('keeps a captured file through draft consumption and handback until it is removed', () => {
  const image = new File(['image'], 'screen.png', { type: 'image/png' })
  const [path] = holdBrowserAttachmentFiles([image])
  stageNativeChatDraftFile('pending', path)
  const images = [{ id: 'screen', path }]
  updateNativeChatComposerDraft('pending', { text: 'Review', images }, 'immediate')
  const submission = captureNativeChatStagedInput('pending', {
    text: 'Review',
    attachments: images
  })

  updateNativeChatComposerDraft('pending', { text: '', images: [] }, 'immediate')
  expect(readBrowserAttachmentFile(path)).toBe(image)
  updateNativeChatComposerDraft('pending', { text: 'Review', images }, 'immediate')
  submission.release()
  expect(readBrowserAttachmentFile(path)).toBe(image)

  updateNativeChatComposerDraft('pending', { text: '', images: [] }, 'immediate')
  expect(readBrowserAttachmentFile(path)).toBeNull()
})

it('keeps captures from both drafts releasable when their attachments merge', () => {
  const paths = holdBrowserAttachmentFiles([
    new File(['source'], 'source.png', { type: 'image/png' }),
    new File(['destination'], 'destination.png', { type: 'image/png' })
  ])
  const captures = ['pending', 'destination'].map((scope, index) => {
    const attachments = [{ id: scope, path: paths[index] }]
    stageNativeChatDraftFile(scope, paths[index])
    updateNativeChatComposerDraft(scope, { images: attachments }, 'immediate')
    return captureNativeChatStagedInput(scope, { text: '', attachments })
  })

  moveNativeChatComposerDraft('pending', 'destination')
  updateNativeChatComposerDraft('destination', { text: '', images: [] }, 'immediate')
  captures[0].release()
  expect(readBrowserAttachmentFile(paths[0])).toBeNull()
  expect(readBrowserAttachmentFile(paths[1])).not.toBeNull()

  captures[1].release()
  expect(readBrowserAttachmentFile(paths[1])).toBeNull()
})

it('adopts a held submission across launch retries without leaving an extra file owner', () => {
  const image = new File(['image'], 'screen.png', { type: 'image/png' })
  const [path] = holdBrowserAttachmentFiles([image])
  stageNativeChatDraftFile('pending', path)
  const input = { text: 'Review', attachments: [{ path }] }
  updateNativeChatComposerDraft(
    'pending',
    { text: input.text, images: [{ id: 'screen', path }] },
    'immediate'
  )
  holdNativeChatStagedInput('pending', input)
  updateNativeChatComposerDraft('pending', { text: '', images: [] }, 'immediate')
  captureNativeChatStagedInput('pending', input)
  const retry = captureNativeChatStagedInput('pending', input)
  expect(readBrowserAttachmentFile(path)).toBe(image)

  retry.release(input)

  expect(readBrowserAttachmentFile(path)).toBeNull()
})

it('releases a held creation image when cancelled after its composer draft was consumed', () => {
  const [path] = holdBrowserAttachmentFiles([
    new File(['image'], 'screen.png', { type: 'image/png' })
  ])
  stageNativeChatDraftFile('pending-worktree-creation:creation', path)
  useAppStore.getState().beginPendingWorktreeCreation({
    creationId: 'creation',
    phase: 'creating',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    heldChatMessage: '',
    heldChatAttachments: [{ id: 'image', path }],
    request: {
      repoId: 'repo',
      name: 'feature',
      setupDecision: 'skip',
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
  })

  useAppStore.getState().removePendingWorktreeCreation('creation')

  expect(readBrowserAttachmentFile(path)).toBeNull()
})

it('remaps complete file references without corrupting files whose names share a prefix', async () => {
  const paths = ['/client/report', '/client/report-backup', '/client/report final.txt']
  paths.forEach((path) => stageNativeChatDraftFile('pending', path))
  uploadPaths.mockResolvedValue({
    uploaded: paths.map((sourcePath, index) => ({ sourcePath, path: `/host/file-${index}` })),
    failed: [],
    skipped: []
  })
  const prepared = await captureNativeChatStagedInput('pending').prepare(
    {
      text: '@"/client/report final.txt" @/client/report @/client/report-backup @/client/report-other'
    },
    session
  )
  expect(prepared.text).toBe('@/host/file-2 @/host/file-0 @/host/file-1 @/client/report-other')
})
