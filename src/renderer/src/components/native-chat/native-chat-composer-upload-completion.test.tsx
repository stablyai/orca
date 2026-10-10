// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { attachNativeChatSessionAttachmentPaths } from './native-chat-session-attachment-drop'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey as scope,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import {
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'

// Only host replies are controlled; pending-chip ownership and upload completion are production code.
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({
    runtimeId: 'paired-host',
    capabilities: ['agent-session.attachments.v1']
  }))
}))
let previousApi: typeof window.api
beforeEach(async () => {
  previousApi = window.api
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
})
afterEach(async () => {
  cleanup()
  await nativeChatComposerDraftWritesSettled()
  clearNativeChatPendingAttachmentsForTests()
  clearNativeChatComposerDraftsForTests()
  window.api = previousApi
})
async function uploadFixture(
  extension: string,
  { removed = false, withSkill = false, switchScope = false } = {}
) {
  const path = `/srv/agent-session-attachments/u1/report.${extension}`
  const sourcePath = `/local/report.${extension}`
  let finish = () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      fs: {
        uploadPathsToAgentSessionAttachments: () =>
          new Promise((resolve) => {
            finish = () => resolve({ uploaded: [{ sourcePath, path }], skipped: [], failed: [] })
          })
      }
    }
  })
  updateNativeChatComposerDraft(scope('a'), { text: 'next question' }, 'immediate')
  if (withSkill) {
    const inputRef = createRef<NativeChatComposerInput>()
    const picker = render(
      <NativeChatPromptEditor
        scopeKey={scope('a')}
        inputRef={inputRef}
        initialValue="$rev"
        disabled={false}
        placeholder="Message"
        onChange={(input) =>
          updateNativeChatComposerDraft(scope('a'), { text: input.value }, 'immediate')
        }
        onSelect={() => {}}
      />
    )
    act(() => {
      inputRef.current?.insertSkill?.(0, 4, '$review')
      if (inputRef.current) {
        inputRef.current.value = '$review-long'
      }
    })
    await vi.waitFor(() =>
      expect(picker.container.querySelector('[data-native-chat-skill]')).not.toBeNull()
    )
    picker.unmount()
  }
  const textareaRef = createRef<NativeChatComposerInput>()
  const view = renderHook(
    ({ draftScope }) => {
      return useNativeChatComposerAttachments({
        attachmentScopeKey: draftScope,
        allowWithoutTarget: true,
        caret: 0,
        disabled: false,
        isComposing: () => false,
        resolveTarget: () => null,
        textareaRef,
        setCaret: () => {},
        setDraft: (updater) =>
          updateNativeChatComposerDraft(
            draftScope,
            { text: updater(readNativeChatComposerDraft(draftScope).text) },
            'immediate'
          ),
        setNotice: () => {}
      })
    },
    { initialProps: { draftScope: scope('a') } }
  )
  let uploaded = Promise.resolve()
  act(() => {
    uploaded = attachNativeChatSessionAttachmentPaths({
      paths: [sourcePath],
      owner: {
        kind: 'runtime-session',
        environmentId: 'paired',
        sessionId: 'a',
        pairingRevision: 1
      },
      chips: view.result.current.pendingChips,
      isAbandoned: () => false,
      ownerStillCurrent: () => true,
      setNotice: () => {}
    })
  })
  await Promise.resolve()
  await Promise.resolve()
  const chip = nativeChatPendingAttachmentSnapshot(scope('a'))[0]
  if (!chip) {
    throw new Error('Expected pending upload chip')
  }
  expect(chip.pendingName).toBe(`report.${extension}`)
  const targetScope = scope('a')
  if (switchScope) {
    act(() => view.rerender({ draftScope: scope('b') }))
    render(
      <NativeChatPromptEditor
        scopeKey={scope('b')}
        inputRef={textareaRef}
        initialValue="other question"
        disabled={false}
        placeholder="Message"
        onChange={(input) =>
          updateNativeChatComposerDraft(scope('b'), { text: input.value }, 'immediate')
        }
        onSelect={() => {}}
      />
    )
  }
  if (removed) {
    act(() => takeNativeChatPendingAttachment(targetScope, chip.id))
  }
  if (!switchScope) {
    view.unmount()
  }
  finish()
  await uploaded
  return {
    path,
    targetScope,
    other: readNativeChatComposerDraft(scope('b')),
    otherInput: textareaRef.current?.value,
    target: readNativeChatComposerDraft(targetScope),
    pending: nativeChatPendingAttachmentSnapshot(targetScope)
  }
}
it.each(['pdf', 'png'])(
  'settles an unmounted paired %s upload in its owning draft',
  async (extension) => {
    const result = await uploadFixture(extension)
    expect(result.pending).toEqual([])
    if (extension === 'pdf') {
      expect(result.target.text).toContain(`@${result.path}`)
    } else {
      expect(result.target.images[0]?.path).toBe(result.path)
    }
    expect(result.other.text).toBe('')
    expect(result.other.images).toEqual([])
  }
)

it('does not attach a file reference removed while uploading', async () => {
  const result = await uploadFixture('pdf', { removed: true })
  expect(result.pending).toEqual([])
  expect(result.target.text).toBe('next question')
})

it('keeps the original file owner when the mounted composer switches draft scopes', async () => {
  const result = await uploadFixture('pdf', { switchScope: true })
  expect(result.pending).toEqual([])
  expect(result.target.text).toBe(`next question\n\n@${result.path}`)
  expect(result.otherInput).toBe('other question')
  expect(result.other.images).toEqual([])
})

it.each(['pdf', 'png'])(
  'preserves a picked skill and its literal suffix after an unmounted %s upload',
  async (extension) => {
    const result = await uploadFixture(extension, { withSkill: true })
    expect(result.pending).toEqual([])
    const inputRef = createRef<NativeChatComposerInput>()
    const view = render(
      <NativeChatPromptEditor
        scopeKey={result.targetScope}
        inputRef={inputRef}
        initialValue={result.target.text}
        disabled={false}
        placeholder="Message"
        onChange={() => {}}
        onSelect={() => {}}
      />
    )
    expect(inputRef.current?.value).toContain('$review-long')
    if (extension === 'pdf') {
      expect(inputRef.current?.value).toContain(`@${result.path}`)
    } else {
      expect(result.target.images[0]?.path).toBe(result.path)
    }
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('[data-native-chat-skill]')).toHaveLength(1)
      expect(view.container.querySelector('[data-native-chat-skill]')?.textContent).toBe('Review')
    })
  }
)
