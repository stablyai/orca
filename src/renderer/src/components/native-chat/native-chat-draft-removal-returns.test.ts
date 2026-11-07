import { createElement, useLayoutEffect, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'
import type { NativeChatComposerInput } from './native-chat-composer-input'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  captureNativeChatComposerSubmission,
  clearNativeChatComposerDraftsForTests,
  finishNativeChatComposerSubmission,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  nativeChatComposerDraftWriteSettled,
  readNativeChatComposerDraft,
  setNativeChatComposerDraftOwnerResolver,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests,
  type NativeChatComposerDraftStorage
} from './native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  settleNativeChatPendingAttachment,
  settleNativeChatPendingAttachmentReferences
} from './native-chat-pending-attachment-cache'
import {
  createNativeChatQueuedEditDraft,
  discardNativeChatQueuedEdit,
  handBackNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import { createChatDraftRemovalReceipt } from '@/store/slices/worktrees/teardown/chat-draft-removal-receipt'
import {
  captureNativeChatStagedInput,
  releaseNativeChatStagedFiles,
  stageNativeChatDraftFile,
  stageNativeChatPendingImage
} from './native-chat-draft-attachment-staging'
import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile
} from '@/lib/browser-attachment-files'
import { settleNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'

const { locate } = vi.hoisted(() => ({ locate: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: locate
}))
const MEMBER = 'agent-session:return-member-37190'
const NEIGHBOUR = 'agent-session:return-neighbour-37190'
const WORKSPACE = 'project-37190::/project'
const owner = { workspaceId: WORKSPACE, executionHostId: 'local' as const }
let storage: NativeChatComposerDraftStorage

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
function holdLocator() {
  const started = deferred<void>()
  const reply = deferred<unknown>()
  locate.mockImplementation(() => {
    started.resolve()
    return reply.promise
  })
  return {
    started: started.promise,
    reply: () =>
      reply.resolve({
        location: { kind: 'chat', sessionId: 'return-member-37190', worktreeId: WORKSPACE }
      })
  }
}
async function reload() {
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
}

beforeEach(async () => {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  setNativeChatComposerDraftOwnerResolver(() => owner)
  await hydrateNativeChatComposerDrafts()
  locate.mockImplementation(async (_target, _method, { address }) => {
    const sessionId = address.slice('orca_session_id:'.length)
    return {
      location: {
        kind: 'chat',
        sessionId,
        worktreeId: sessionId === 'return-member-37190' ? WORKSPACE : 'other-project::/elsewhere'
      }
    }
  })
})
afterEach(() => {
  cleanup()
  nativeChatPastedTextOperations.clear()
  releaseNativeChatStagedFiles(MEMBER)
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
})

it.each(['file reference', 'long paste'])(
  'clears a captured %s completed during membership lookup',
  async (kind) => {
    const id = '00000000-0000-0000-0000-000000037190'
    if (kind === 'long paste') {
      nativeChatPastedTextOperations.set(id, {
        scopeKey: MEMBER,
        text: 'captured clipboard source'
      })
      updateNativeChatComposerDraft(
        MEMBER,
        { text: '[Pasted text](orca-paste:00000000-0000-0000-0000-000000037190)' },
        'immediate'
      )
    } else {
      updateNativeChatComposerDraft(MEMBER, { text: 'captured attachment' }, 'immediate')
      addNativeChatPendingAttachment(MEMBER, { id, path: '', pending: true })
    }
    await nativeChatComposerDraftWritesSettled()
    const held = holdLocator()
    const removing = remove()
    await held.started
    expect(
      kind === 'long paste'
        ? settleNativeChatPastedText(id, '/clipboard.txt')
        : settleNativeChatPendingAttachmentReferences(MEMBER, [{ id, path: '/report.pdf' }])
    ).toBe(true)
    await nativeChatComposerDraftWritesSettled()
    held.reply()
    await removing
    await reload()
    expect(readNativeChatComposerDraft(MEMBER)).toMatchObject({ text: '', images: [] })
  }
)
function remove() {
  const receipt = createChatDraftRemovalReceipt(() => ({ unifiedTabsByWorktree: {} }))
  receipt.capture({ executionHostId: 'local' })({ projectId: 'project-37190' })
  return receipt.finish()
}

it('selected failed-send, chip and queued-edit returns cannot revive a removed member', async () => {
  updateNativeChatComposerDraft(MEMBER, { text: 'failed send' }, 'immediate')
  const submission = captureNativeChatComposerSubmission(MEMBER)
  updateNativeChatComposerDraft(MEMBER, { text: '' }, 'immediate')
  addNativeChatPendingAttachment(MEMBER, { id: 'old-chip', path: '', pending: true })
  const edit = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'accepted queue card' }]
    },
    MEMBER
  )
  updateNativeChatComposerDraft(edit.scopeKey, { text: 'unsent edit return' }, 'immediate')
  addNativeChatPendingAttachment(edit.scopeKey, { id: 'edit-chip', path: '', pending: true })
  await nativeChatComposerDraftWritesSettled()
  await remove()
  finishNativeChatComposerSubmission(MEMBER, submission, true)
  expect(settleNativeChatPendingAttachment(MEMBER, 'old-chip', '/old.png')).toBe(false)
  expect(settleNativeChatPendingAttachment(edit.scopeKey, 'edit-chip', '/edit.png')).toBe(false)
  const activeEdit = { ...edit, sessionId: 'return-member-37190' }
  expect(handBackNativeChatQueuedEdit(activeEdit, true)).toBe(false)
  expect(readNativeChatComposerDraft(MEMBER)).toMatchObject({ text: '', images: [] })

  // The editor remains usable; only its captured return generation was revoked.
  updateNativeChatComposerDraft(edit.scopeKey, { text: 'later editor input' }, 'immediate')
  addNativeChatPendingAttachment(edit.scopeKey, { id: 'new-chip', path: '', pending: true })
  expect(handBackNativeChatQueuedEdit(edit, true)).toBe(true)
  discardNativeChatQueuedEdit(edit)
  expect(settleNativeChatPendingAttachment(edit.scopeKey, 'new-chip', '/new.png')).toBe(true)
  expect(readNativeChatComposerDraft(MEMBER)).toMatchObject({
    text: 'later editor input',
    images: [{ id: 'new-chip', path: '/new.png' }]
  })
  const laterSubmission = captureNativeChatComposerSubmission(MEMBER)
  updateNativeChatComposerDraft(MEMBER, { text: '', images: [] }, 'immediate')
  finishNativeChatComposerSubmission(MEMBER, laterSubmission, true)
  expect(readNativeChatComposerDraft(MEMBER).text).toBe('later editor input')
  await nativeChatComposerDraftWritesSettled()
})

it('clears captured returns completed during membership lookup, including a copied queued editor', async () => {
  updateNativeChatComposerDraft(MEMBER, { text: 'failed send' }, 'immediate')
  const submission = captureNativeChatComposerSubmission(MEMBER)
  updateNativeChatComposerDraft(MEMBER, { text: '' }, 'immediate')
  addNativeChatPendingAttachment(MEMBER, { id: 'held-chip', path: '', pending: true })
  const edit = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'queued return' }]
    },
    MEMBER
  )
  updateNativeChatComposerDraft(edit.scopeKey, { text: 'captured editor input' }, 'immediate')
  addNativeChatPendingAttachment(edit.scopeKey, {
    id: 'returned-edit-chip',
    path: '',
    pending: true
  })
  await nativeChatComposerDraftWritesSettled()
  const held = holdLocator()
  const removing = remove()
  await held.started
  finishNativeChatComposerSubmission(MEMBER, submission, true)
  const [capturedPath] = holdBrowserAttachmentFiles([new File(['captured'], 'captured.png')])
  expect(stageNativeChatPendingImage(MEMBER, 'held-chip', capturedPath)).toBe(true)
  expect(settleNativeChatPendingAttachment(MEMBER, 'held-chip', capturedPath)).toBe(true)
  const [returnedPath] = holdBrowserAttachmentFiles([new File(['returned'], 'returned.png')])
  expect(stageNativeChatPendingImage(edit.scopeKey, 'returned-edit-chip', returnedPath)).toBe(true)
  expect(handBackNativeChatQueuedEdit({ ...edit }, true)).toBe(true)
  discardNativeChatQueuedEdit(edit)
  await nativeChatComposerDraftWritesSettled()
  held.reply()
  await removing
  expect(readBrowserAttachmentFile(capturedPath)).toBeNull()
  expect(readBrowserAttachmentFile(returnedPath)).toBeNull()
  expect(
    settleNativeChatPendingAttachment(edit.scopeKey, 'returned-edit-chip', '/captured-edit.png')
  ).toBe(false)
  expect(readNativeChatComposerDraft(MEMBER)).toMatchObject({ text: '', images: [] })
  await reload()
  expect(readNativeChatComposerDraft(MEMBER)).toMatchObject({ text: '', images: [] })
})

it('preserves a captured return mixed with input created during membership lookup', async () => {
  updateNativeChatComposerDraft(MEMBER, { text: 'failed send' }, 'immediate')
  const submission = captureNativeChatComposerSubmission(MEMBER)
  updateNativeChatComposerDraft(MEMBER, { text: '' }, 'immediate')
  addNativeChatPendingAttachment(MEMBER, { id: 'held-chip', path: '', pending: true })
  await nativeChatComposerDraftWritesSettled()
  const held = holdLocator()
  const removing = remove()
  await held.started
  updateNativeChatComposerDraft(MEMBER, { text: 'new independent input' }, 'immediate')
  finishNativeChatComposerSubmission(MEMBER, submission, true)
  expect(settleNativeChatPendingAttachment(MEMBER, 'held-chip', '/captured.png')).toBe(true)
  await nativeChatComposerDraftWritesSettled()
  held.reply()
  await removing
  await reload()
  expect(readNativeChatComposerDraft(MEMBER)).toMatchObject({
    text: 'new independent input\n\nfailed send',
    images: [{ id: 'held-chip', path: '/captured.png' }]
  })
})

it('retires selected browser files while later chips and transport leases stay usable', async () => {
  const [oldPath, laterPath, leasedPath] = holdBrowserAttachmentFiles([
    new File(['old'], 'old.png'),
    new File(['later'], 'later.png'),
    new File(['lease'], 'lease.png')
  ])
  updateNativeChatComposerDraft(
    MEMBER,
    {
      text: 'captured',
      images: [
        { id: 'old', path: oldPath },
        { id: 'leased', path: leasedPath }
      ]
    },
    'immediate'
  )
  stageNativeChatDraftFile(MEMBER, oldPath)
  stageNativeChatDraftFile(MEMBER, leasedPath)
  await nativeChatComposerDraftWritesSettled()
  const held = holdLocator()
  const removing = remove()
  await held.started
  addNativeChatPendingAttachment(MEMBER, { id: 'later-chip', path: '', pending: true })
  expect(stageNativeChatPendingImage(MEMBER, 'later-chip', laterPath)).toBe(true)
  const lease = captureNativeChatStagedInput(MEMBER, {
    text: '',
    attachments: [{ path: leasedPath }]
  })
  held.reply()
  await removing
  expect(readBrowserAttachmentFile(oldPath)).toBeNull()
  expect(readBrowserAttachmentFile(laterPath)?.name).toBe('later.png')
  expect(readBrowserAttachmentFile(leasedPath)?.name).toBe('lease.png')
  expect(settleNativeChatPendingAttachment(MEMBER, 'later-chip', laterPath)).toBe(true)
  lease.release()
  expect(readBrowserAttachmentFile(leasedPath)).toBeNull()
  expect(readNativeChatComposerDraft(MEMBER).images).toEqual([
    { id: 'later-chip', path: laterPath }
  ])
})

it('equivalent obligations of a current nonmember remain usable', async () => {
  updateNativeChatComposerDraft(NEIGHBOUR, { text: 'neighbour failed send' }, 'immediate')
  const submission = captureNativeChatComposerSubmission(NEIGHBOUR)
  updateNativeChatComposerDraft(NEIGHBOUR, { text: '' }, 'immediate')
  addNativeChatPendingAttachment(NEIGHBOUR, { id: 'neighbour-chip', path: '', pending: true })
  const edit = createNativeChatQueuedEditDraft(
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'neighbour queued return' }]
    },
    NEIGHBOUR
  )
  await nativeChatComposerDraftWritesSettled()
  await remove()
  finishNativeChatComposerSubmission(NEIGHBOUR, submission, true)
  expect(settleNativeChatPendingAttachment(NEIGHBOUR, 'neighbour-chip', '/neighbour.png')).toBe(
    true
  )
  expect(handBackNativeChatQueuedEdit(edit, true)).toBe(true)
  expect(readNativeChatComposerDraft(NEIGHBOUR)).toMatchObject({
    text: 'neighbour failed send\n\nneighbour queued return',
    images: [{ id: 'neighbour-chip', path: '/neighbour.png' }]
  })
  discardNativeChatQueuedEdit(edit)
  await nativeChatComposerDraftWritesSettled()
})

it.each([false, true])(
  'follows a captured editor completion into hand-back while preserving independent input=%s',
  async (independent) => {
    const edit = createNativeChatQueuedEditDraft(
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'accepted queue card' }]
      },
      MEMBER
    )
    updateNativeChatComposerDraft(edit.scopeKey, { text: 'captured editor' }, 'immediate')
    addNativeChatPendingAttachment(edit.scopeKey, {
      id: 'editor-completes-first',
      path: '',
      pending: true
    })
    const held = holdLocator()
    const removing = remove()
    await held.started
    if (independent) {
      updateNativeChatComposerDraft(
        edit.scopeKey,
        { text: 'new independent editor input' },
        'immediate'
      )
    }
    expect(
      settleNativeChatPendingAttachment(edit.scopeKey, 'editor-completes-first', '/editor.png')
    ).toBe(true)
    expect(handBackNativeChatQueuedEdit({ ...edit }, true)).toBe(true)
    discardNativeChatQueuedEdit(edit)
    await nativeChatComposerDraftWritesSettled()
    held.reply()
    await removing
    await reload()
    expect(readNativeChatComposerDraft(MEMBER)).toMatchObject(
      independent
        ? {
            text: 'new independent editor input',
            images: [{ id: 'editor-completes-first', path: '/editor.png' }]
          }
        : { text: '', images: [] }
    )
  }
)

it.each([false, true])(
  'settles mounted file-reference batches while preserving an independent contributor=%s',
  async (independent) => {
    let composing = true
    let attachment!: ReturnType<typeof useNativeChatResolvedPathAttachments>
    const input: { current: NativeChatComposerInput | null } = { current: null }
    function Composer() {
      const field = useRef<NativeChatComposerInput>(null)
      const mounted = useRef(true)
      const draft = useNativeChatDraft(MEMBER, () => false)
      attachment = useNativeChatResolvedPathAttachments({
        caret: 0,
        disabled: false,
        isComposing: () => composing,
        mountedRef: mounted,
        attachmentTargetBlocked: () => false,
        noteAttachmentTargetBlocked: () => {},
        setCaret: () => {},
        setNotice: () => {},
        appendImageAttachments: () => {},
        setDraft: draft.setDraft,
        textareaRef: field
      })
      useLayoutEffect(() => {
        input.current = field.current
        if (field.current && field.current.value !== draft.draft) {
          field.current.value = draft.draft
        }
      }, [draft.draft])
      return createElement(NativeChatPromptEditor, {
        scopeKey: MEMBER,
        inputRef: field,
        initialValue: draft.draft,
        disabled: false,
        placeholder: 'Message',
        onChange: () => {},
        onSelect: () => {}
      })
    }
    render(createElement(Composer))
    addNativeChatPendingAttachment(MEMBER, { id: 'captured-pdf', path: '', pending: true })
    const held = holdLocator()
    const removing = remove()
    await held.started
    act(() => {
      attachment.attachResolvedPaths(['/captured.pdf'], null, {
        operation: {
          apply: (insert) =>
            settleNativeChatPendingAttachmentReferences(
              MEMBER,
              [{ id: 'captured-pdf', path: '/captured.pdf' }],
              insert ?? undefined
            ),
          cancel: () => {}
        }
      })
      if (independent) {
        attachment.attachResolvedPaths(['/later.pdf'])
      }
      composing = false
      attachment.flushPendingAttachments()
    })
    expect(input.current?.value).toBe(
      independent ? '@/captured.pdf @/later.pdf ' : '@/captured.pdf '
    )
    await act(async () => {
      held.reply()
      await removing
    })
    expect(input.current?.value).toBe(independent ? '@/captured.pdf @/later.pdf ' : '')
    await nativeChatComposerDraftWriteSettled(MEMBER)
    cleanup()
    await nativeChatComposerDraftWritesSettled()
    await reload()
    expect(readNativeChatComposerDraft(MEMBER).text).toBe(
      independent ? '@/captured.pdf @/later.pdf ' : ''
    )
  }
)
