// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
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
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
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

  it('excludes a pending chip from the scope cache while a settled chip persists', async () => {
    const probe = await renderProbe('pty-1')
    let pendingId: string | null = null
    act(() => {
      pendingId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/settled.png'])
    })

    const cached = readNativeChatAttachmentCache('pty-1')
    expect(cached.some((attachment) => attachment.id === pendingId)).toBe(false)
    expect(cached).toMatchObject([{ path: '/tmp/settled.png' }])
    expect(cached[0]?.previewUrl).toBeUndefined()
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
