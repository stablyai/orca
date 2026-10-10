// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import * as draftCache from './native-chat-draft-cache'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { nativeChatPendingAttachmentSnapshot } from './native-chat-pending-attachment-cache'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
const runtimeTarget = vi.hoisted(() => ({ remote: false }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => runtimeTarget.remote
}))

type AttachmentApi = ReturnType<typeof useNativeChatComposerAttachments>
type ProbeApi = AttachmentApi & { adoptDraft: (draft: string) => void }

const target: NativeChatResolvedTarget = {
  ptyId: 'pty-1',
  settings: { activeRuntimeEnvironmentId: null }
}

function Probe({
  scopeKey,
  structured = false,
  disabled = false,
  isComposing,
  onReady
}: {
  scopeKey: string
  structured?: boolean
  disabled?: boolean
  isComposing: () => boolean
  onReady: (api: ProbeApi) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [draftValue, setDraftValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: structured,
    caret,
    disabled,
    isComposing,
    resolveTarget: () => (structured ? null : target),
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraftValue((previous) => updater(previous)),
    setNotice
  })
  useEffect(() => {
    onReady({ ...api, adoptDraft: setDraftValue })
  }, [api, onReady])
  return (
    <div>
      <textarea ref={textareaRef} />
      <output data-draft>{draftValue}</output>
      <output data-notice>{notice}</output>
    </div>
  )
}

async function renderProbe(
  scopeKey: string,
  structured = false,
  options: { disabled?: boolean; isComposing?: () => boolean } = {}
): Promise<{
  draft: () => string
  latest: () => ProbeApi
  notice: () => string
  rerender: (scopeKey: string, disabled?: boolean) => Promise<void>
  root: Root
  textarea: () => HTMLTextAreaElement
}> {
  const container = document.createElement('div')
  document.body.append(container)
  // onReady fires on every render, so keep the freshest snapshot — reading a
  // single captured `api` would go stale after attach/remove triggers a render.
  let api: ProbeApi | null = null
  const root = createRoot(container)
  const onReady = (next: ProbeApi): void => {
    api = next
  }
  const isComposing = options.isComposing ?? (() => false)
  const render = async (nextScopeKey: string, disabled: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(Probe, {
          scopeKey: nextScopeKey,
          structured,
          disabled,
          isComposing,
          onReady
        })
      )
    })
  }
  await render(scopeKey, options.disabled ?? false)
  if (!api) {
    throw new Error('Probe did not render')
  }
  return {
    draft: () => container.querySelector('[data-draft]')?.textContent ?? '',
    root,
    latest: () => {
      if (!api) {
        throw new Error('Probe is not mounted')
      }
      return api
    },
    notice: () => container.querySelector('[data-notice]')?.textContent ?? '',
    rerender: (nextScopeKey: string, disabled = options.disabled ?? false) =>
      render(nextScopeKey, disabled),
    textarea: () => {
      const textarea = container.querySelector('textarea')
      if (!textarea) {
        throw new Error('Probe textarea is not mounted')
      }
      return textarea
    }
  }
}

describe('useNativeChatComposerAttachments', () => {
  afterEach(() => {
    runtimeTarget.remote = false
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
  })

  it('reexports the attachment cache functions from the draft store view', () => {
    expect(readNativeChatAttachmentCache).toBe(draftCache.readNativeChatAttachmentCache)
    expect(appendNativeChatAttachmentCache).toBe(draftCache.appendNativeChatAttachmentCache)
    expect(clearNativeChatAttachmentCacheForTests).toBe(
      draftCache.clearNativeChatAttachmentCacheForTests
    )
  })

  it('holds attached images as chips (deferred to submit) and restores them on remount', async () => {
    const first = await renderProbe('pty-1')

    await act(async () => {
      first.latest().attachResolvedPaths(['/tmp/orca-native-chat-attach-test.png'])
    })

    // Images are NOT sent to the TUI on attach — they ride along on submit, so
    // the chip and the TUI input never diverge and removing a chip is clean.
    expect(first.latest().imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])

    act(() => first.root.unmount())
    const second = await renderProbe('pty-1')

    expect(second.latest().imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    act(() => second.root.unmount())
  })

  it('accepts host-readable image paths without a PTY for structured transport', async () => {
    const probe = await renderProbe('structured-session-1', true)

    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/structured-image.png'])
    })

    expect(probe.latest().imageAttachments).toMatchObject([{ path: '/tmp/structured-image.png' }])
    act(() => probe.root.unmount())
  })

  it('accepts only ownership-validated paths for a remote runtime target', async () => {
    runtimeTarget.remote = true
    const probe = await renderProbe('remote-pty')

    act(() => probe.latest().attachResolvedPaths(['/remote/untrusted.txt']))
    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')

    act(() =>
      probe.latest().attachResolvedPaths(['/remote/trusted.txt'], undefined, {
        targetOwnerIsCurrent: () => true
      })
    )
    expect(probe.draft()).toBe('@/remote/trusted.txt ')
    act(() => probe.root.unmount())
  })

  it('rejects an ownership-validated path when its owner changes before IME flush', async () => {
    let composing = true
    let ownerCurrent = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() =>
      probe.latest().attachResolvedPaths(['/remote/trusted.txt'], undefined, {
        targetOwnerIsCurrent: () => ownerCurrent
      })
    )
    ownerCurrent = false
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Files can only be attached to their source workspace.')
    act(() => probe.root.unmount())
  })

  // Today's only caller settles ownership synchronously before it calls, so this
  // verdict cannot arrive false — but the hook exports this entry point. Pinned
  // because the fallback is not a refusal: a false verdict is not "owned", so a
  // remote target would blame client-local attachments for an ownership failure.
  it('names the ownership failure when an immediate attach arrives already false', async () => {
    runtimeTarget.remote = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => false })

    act(() =>
      probe.latest().attachResolvedPaths(['/remote/moved.txt'], undefined, {
        targetOwnerIsCurrent: () => false
      })
    )

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Files can only be attached to their source workspace.')
    act(() => probe.root.unmount())
  })

  // Ownership is per path: the target-owned drop still lands, the client-local
  // paste is refused, and the refusal is reported rather than hidden.
  it('keeps the owned half of a mixed queued batch after the target becomes remote', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => {
      probe.latest().attachResolvedPaths(['/remote/trusted.txt'], undefined, {
        targetOwnerIsCurrent: () => true
      })
      probe.latest().attachResolvedPaths(['/local/untrusted.txt'])
    })
    runtimeTarget.remote = true
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('@/remote/trusted.txt ')
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')
    act(() => probe.root.unmount())
  })

  // References are inserted in the order the user made them. Splitting the queue
  // into an owned half and a client-local half would hoist every workspace drop
  // ahead of a paste that came first.
  it('keeps a mixed queued batch in the order it was attached', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => {
      probe.latest().attachResolvedPaths(['/local/first.txt'])
      probe.latest().attachResolvedPaths(['/remote/second.txt'], undefined, {
        targetOwnerIsCurrent: () => true
      })
    })
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('@/local/first.txt @/remote/second.txt ')
    act(() => probe.root.unmount())
  })

  it('refuses a wholly client-local queued batch on a remote target', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => probe.latest().attachResolvedPaths(['/local/untrusted.txt']))
    runtimeTarget.remote = true
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')
    act(() => probe.root.unmount())
  })

  // An already-blocked target refuses at the drop instead of queueing. Queued
  // paths that can never attach would still spend the pending budget, and the
  // next legitimate drop would be turned away for being one too many.
  it('refuses an already-blocked target at the drop without spending the queue budget', async () => {
    runtimeTarget.remote = true
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    const refused = Array.from(
      { length: NATIVE_FILE_DROP_MAX_PATHS },
      (_unused, index) => `/local/refused-${index}.txt`
    )
    act(() => probe.latest().attachResolvedPaths(refused))
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')

    runtimeTarget.remote = false
    act(() => probe.latest().attachResolvedPaths(['/local/allowed.txt']))
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('@/local/allowed.txt ')
    act(() => probe.root.unmount())
  })

  it('removes an attached image chip cleanly', async () => {
    const probe = await renderProbe('pty-1')
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/orca-native-chat-remove-test.png'])
    })
    const id = probe.latest().imageAttachments[0]?.id
    expect(id).toBeDefined()
    await act(async () => {
      probe.latest().removeImageAttachment(id as string)
    })
    expect(probe.latest().imageAttachments).toMatchObject([])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([])
    act(() => probe.root.unmount())
  })

  it('adopts browser text before draining ordered duplicate paths exactly once', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })
    const textarea = probe.textarea()
    textarea.focus()
    textarea.value = '각 '
    textarea.setSelectionRange(2, 2)
    const focus = vi.spyOn(textarea, 'focus')

    act(() => {
      probe.latest().attachResolvedPaths(['/remote/b.txt', '/remote/b.txt'])
      probe.latest().attachResolvedPaths(['/remote/a.txt'])
    })
    expect(probe.draft()).toBe('')

    composing = false
    textarea.blur()
    act(() => {
      probe.latest().adoptDraft(textarea.value)
      probe.latest().flushPendingAttachments()
      probe.latest().flushPendingAttachments()
    })

    expect(probe.draft()).toBe('각 @/remote/b.txt @/remote/b.txt @/remote/a.txt ')
    // The focus this flush must not steal would be scheduled a frame out, so without advancing
    // one the assertions below hold even when the flush does steal focus.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(textarea)
    act(() => probe.root.unmount())
  })

  it('drops queued paths after any disabled transition', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => probe.latest().attachResolvedPaths(['/remote/a.txt']))
    await probe.rerender('pty-1', true)
    await probe.rerender('pty-1', false)
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    act(() => probe.root.unmount())
  })

  it('caps paths queued during composition and keeps overflow visible after flush', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })
    const acceptedPaths = Array.from(
      { length: NATIVE_FILE_DROP_MAX_PATHS },
      (_, index) => `/remote/accepted-${index}.txt`
    )

    act(() => {
      probe.latest().attachResolvedPaths(acceptedPaths)
      probe.latest().attachResolvedPaths(['/remote/rejected.txt'])
    })

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe(
      'Too many attachments are waiting. Finish composing before attaching more.'
    )

    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft().match(/@\/remote\/accepted-/g)).toHaveLength(NATIVE_FILE_DROP_MAX_PATHS)
    expect(probe.draft()).not.toContain('rejected.txt')
    expect(probe.notice()).toBe(
      'Too many attachments are waiting. Finish composing before attaching more.'
    )
    act(() => probe.root.unmount())
  })

  it('settles a pending image attachment in place', async () => {
    const probe = await renderProbe('pty-1')
    let id: string | null = null
    act(() => {
      id = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    expect(id).toBeTruthy()
    expect(probe.latest().imageAttachments).toMatchObject([
      { id, path: '', previewUrl: 'blob:preview-1', pending: true }
    ])

    act(() => {
      probe.latest().resolvePendingImageAttachment(id as string, '/tmp/resolved.png', 'conn-1')
    })

    expect(probe.latest().imageAttachments).toMatchObject([
      { id, path: '/tmp/resolved.png', previewUrl: 'blob:preview-1', connectionId: 'conn-1' }
    ])
    expect(probe.latest().imageAttachments[0]?.pending).toBeUndefined()
    act(() => probe.root.unmount())
  })

  it('drops just the targeted pending chip', async () => {
    const probe = await renderProbe('pty-1')
    let firstId: string | null = null
    let secondId: string | null = null
    act(() => {
      firstId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    act(() => {
      secondId = probe.latest().beginPendingImageAttachment('blob:preview-2')
    })

    act(() => {
      probe.latest().dropPendingImageAttachment(firstId as string)
    })

    expect(probe.latest().imageAttachments).toMatchObject([
      { id: secondId, previewUrl: 'blob:preview-2', pending: true }
    ])
    act(() => probe.root.unmount())
  })

  it('tells a finishing upload that the user removed its chip', async () => {
    const probe = await renderProbe('pty-1')
    const begun: { removed?: string | null; kept?: string | null } = {}
    act(() => {
      begun.removed = probe.latest().pendingChips.begin(undefined, 'report.pdf')
      begun.kept = probe.latest().pendingChips.begin(undefined, 'notes.md')
    })
    const { removed, kept } = begun
    if (!removed || !kept) {
      throw new Error('expected pending chips')
    }
    act(() => probe.latest().removeImageAttachment(removed))

    const live: boolean[] = []
    act(() => {
      live.push(probe.latest().pendingChips.drop(removed), probe.latest().pendingChips.drop(kept))
    })
    expect(live).toEqual([false, true])
    expect(probe.latest().imageAttachments).toEqual([])
    act(() => probe.root.unmount())
  })

  it('keeps an upload that finishes while the composer is unmounted, for when it returns', async () => {
    const probe = await renderProbe('pty-gone')
    const chips = probe.latest().pendingChips
    const begun: { image?: string | null; removed?: string | null; reference?: string | null } = {}
    act(() => {
      begun.image = chips.begin(undefined, 'shot.png')
      begun.removed = chips.begin(undefined, 'old.png')
      begun.reference = chips.begin(undefined, 'notes.pdf')
    })
    const { image, removed, reference } = begun
    if (!image || !removed || !reference) {
      throw new Error('expected pending chips')
    }
    act(() => probe.latest().removeImageAttachment(removed))
    // A prompt card took the composer's place while the files uploaded.
    act(() => probe.root.unmount())

    chips.resolve(image, '/srv/agent-session-attachments/u1/shot.png')
    chips.resolve(removed, '/srv/agent-session-attachments/u2/old.png')
    chips.attachReferences([{ id: reference, path: '/srv/agent-session-attachments/u3/notes.pdf' }])

    expect(readNativeChatAttachmentCache('pty-gone')).toEqual([
      { id: image, path: '/srv/agent-session-attachments/u1/shot.png' }
    ])
    expect(readNativeChatDraftCache('pty-gone')).toBe(
      '@/srv/agent-session-attachments/u3/notes.pdf'
    )
    const back = await renderProbe('pty-gone')
    expect(back.latest().imageAttachments).toMatchObject([
      { path: '/srv/agent-session-attachments/u1/shot.png' }
    ])
    act(() => back.root.unmount())
  })

  it('shows a dropped file still uploading as pending to a composer that comes back, then settles it there', async () => {
    const first = await renderProbe('pty-drop')
    const chips = first.latest().pendingChips
    let chipId: string | null = null
    act(() => {
      chipId = chips.begin(undefined, 'shot.png')
    })
    if (!chipId) {
      throw new Error('expected a pending chip')
    }
    const id: string = chipId
    act(() => first.root.unmount())

    const back = await renderProbe('pty-drop')
    expect(back.latest().imageAttachments).toMatchObject([
      { id, pending: true, pendingName: 'shot.png' }
    ])
    act(() => chips.resolve(id, '/srv/agent-session-attachments/u5/shot.png'))
    expect(back.latest().imageAttachments).toEqual([
      { id, path: '/srv/agent-session-attachments/u5/shot.png' }
    ])
    act(() => back.root.unmount())
  })

  it('gives uploads unique IDs across composers remounted in the same clock tick', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const first = await renderProbe('pty-ids', true)
      const ids: (string | null)[] = []
      act(() => ids.push(first.latest().pendingChips.begin(undefined, 'first.pdf')))
      act(() => first.root.unmount())
      const next = await renderProbe('pty-ids', true)
      act(() => ids.push(next.latest().pendingChips.begin(undefined, 'second.pdf')))
      expect(new Set(ids).size).toBe(2)
      expect(nativeChatPendingAttachmentSnapshot('pty-ids')).toHaveLength(2)
      act(() => next.root.unmount())
    } finally {
      now.mockRestore()
    }
  })

  it('inserts a stored file at the caret while the composer is showing and not composing', async () => {
    const probe = await renderProbe('pty-caret', true)
    act(() => {
      const chips = probe.latest().pendingChips
      const id = chips.begin(undefined, 'a.pdf')
      if (!id) {
        throw new Error('expected pending chip')
      }
      chips.attachReferences([{ id, path: '/srv/agent-session-attachments/u6/a.pdf' }])
    })
    expect(probe.draft()).toBe('@/srv/agent-session-attachments/u6/a.pdf ')
    expect(readNativeChatDraftCache('pty-caret')).toBe('')
    act(() => probe.root.unmount())
  })

  it('keeps a stored file whose reference is held for an input-method composition across a remount', async () => {
    let composing = true
    const probe = await renderProbe('pty-ime', true, { isComposing: () => composing })
    const chips = probe.latest().pendingChips
    let chipId: string | null = null
    act(() => {
      chipId = chips.begin(undefined, 'notes.pdf')
    })
    if (!chipId) {
      throw new Error('expected a pending chip')
    }
    const id: string = chipId
    // The upload finishes mid-composition: the reference waits for the composition to settle.
    act(() => {
      chips.attachReferences([{ id, path: '/srv/agent-session-attachments/u4/notes.pdf' }])
    })
    // A prompt card takes the composer's place before the composition settles.
    act(() => probe.root.unmount())
    composing = false

    expect(readNativeChatDraftCache('pty-ime')).toContain(
      '@/srv/agent-session-attachments/u4/notes.pdf'
    )
  })

  it('keeps a pending chip in the pending cache, without its preview, and the settled one in the draft', async () => {
    const probe = await renderProbe('pty-1')
    let pendingId: string | null = null
    act(() => {
      pendingId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/settled.png'])
    })

    // A composer that comes back must still wait for the pending one, which no draft saves.
    expect(nativeChatPendingAttachmentSnapshot('pty-1')).toEqual([
      { id: pendingId, path: '', pending: true }
    ])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([{ path: '/tmp/settled.png' }])
    expect(
      probe.latest().imageAttachments.find((attachment) => attachment.id === pendingId)?.previewUrl
    ).toBe('blob:preview-1')
    act(() => probe.root.unmount())
  })

  it('revokes a blob: preview URL on removal but not a data: preview URL', async () => {
    const probe = await renderProbe('pty-1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    let blobId: string | null = null
    act(() => {
      blobId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    act(() => {
      probe.latest().beginPendingImageAttachment('data:image/png;base64,AAAA')
    })

    act(() => {
      probe.latest().dropPendingImageAttachment(blobId as string)
    })
    expect(revoke).toHaveBeenCalledWith('blob:preview-1')

    // Only the remaining data: chip is left to clear; revoke must not fire again.
    revoke.mockClear()
    act(() => {
      probe.latest().clearImageAttachments()
    })
    expect(revoke).not.toHaveBeenCalled()
    act(() => probe.root.unmount())
  })
})
