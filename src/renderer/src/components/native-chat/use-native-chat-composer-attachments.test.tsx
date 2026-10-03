// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderHook } from '@testing-library/react'
import {
  addNativeChatDraftAttachments,
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftAttachments
} from './native-chat-draft-cache'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { installLocalStorageNativeChatDrafts } from './native-chat-draft-store.test-support'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
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
  beforeEach(() => installLocalStorageNativeChatDrafts())
  afterEach(() => {
    runtimeTarget.remote = false
    clearNativeChatDraftCacheForTests()
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
    expect(readNativeChatDraftAttachments('pty-1')).toMatchObject([
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

  it('shows every chip in every view of the chat, a pending one included', async () => {
    const first = await renderProbe('session:chat-1', true)
    const second = await renderProbe('session:chat-1', true)

    await act(async () => {
      first.latest().attachResolvedPaths(['/tmp/shared.png'])
    })
    act(() => {
      first.latest().beginPendingImageAttachment('blob:preview-1')
    })
    expect(second.latest().imageAttachments).toMatchObject([
      { path: '/tmp/shared.png' },
      { pending: true }
    ])

    const id = second.latest().imageAttachments[0]?.id ?? ''
    act(() => second.latest().removeImageAttachment(id))

    expect(first.latest().imageAttachments).toMatchObject([{ pending: true }])
    act(() => first.root.unmount())
    act(() => second.root.unmount())
  })

  it("shows chips written between a view's render and its subscription", () => {
    const { result, unmount } = renderHook(() => {
      const view = useNativeChatComposerAttachments({
        attachmentScopeKey: 'session:chat-gap',
        allowWithoutTarget: true,
        caret: 0,
        disabled: false,
        isComposing: () => false,
        resolveTarget: () => null,
        textareaRef: { current: null },
        setCaret: () => {},
        setDraft: () => {},
        setNotice: () => {}
      })
      useLayoutEffect(
        () =>
          addNativeChatDraftAttachments('session:chat-gap', [{ id: 'late', path: '/late.png' }]),
        []
      )
      return view
    })

    expect(result.current.imageAttachments).toMatchObject([{ path: '/late.png' }])
    unmount()
  })

  it('keeps chips in the order they were added while a paste is still saving', async () => {
    const probe = await renderProbe('session:chat-order', true)
    let pastedId: string | null = null
    act(() => {
      pastedId = probe.latest().beginPendingImageAttachment('blob:pasted')
    })
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/dropped.png'])
    })
    act(() => probe.latest().resolvePendingImageAttachment(pastedId ?? '', '/tmp/pasted.png'))

    expect(probe.latest().imageAttachments.map(({ path }) => path)).toEqual([
      '/tmp/pasted.png',
      '/tmp/dropped.png'
    ])
    act(() => probe.root.unmount())
  })

  it('keeps one chip order in every pane and on disk while a paste saves and chips come and go', async () => {
    const first = await renderProbe('session:chat-race', true)
    const second = await renderProbe('session:chat-race', true)
    let pastedId: string | null = null
    act(() => {
      pastedId = first.latest().beginPendingImageAttachment('blob:pasted')
    })
    await act(async () => {
      first.latest().attachResolvedPaths(['/tmp/first.png'])
    })
    await act(async () => {
      second.latest().attachResolvedPaths(['/tmp/second.png'])
    })
    act(() => first.latest().resolvePendingImageAttachment(pastedId ?? '', '/tmp/pasted.png'))
    const order = () => ({
      first: first.latest().imageAttachments.map(({ path }) => path),
      second: second.latest().imageAttachments.map(({ path }) => path),
      saved: JSON.parse(
        localStorage.getItem(
          `orca:nativeChatComposerDraft:v1:${encodeURIComponent('session:chat-race')}`
        ) ?? 'null'
      ).attachments.map(({ path }: { path: string }) => path)
    })

    const all = ['/tmp/pasted.png', '/tmp/first.png', '/tmp/second.png']
    expect(order()).toEqual({ first: all, second: all, saved: all })
    act(() => second.latest().removeImageAttachment(first.latest().imageAttachments[1]!.id))
    const rest = ['/tmp/pasted.png', '/tmp/second.png']
    expect(order()).toEqual({ first: rest, second: rest, saved: rest })
    act(() => first.root.unmount())
    act(() => second.root.unmount())
  })

  it('keeps both chips when two views attach in the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const first = await renderProbe('session:chat-same-ms', true)
    const second = await renderProbe('session:chat-same-ms', true)
    await act(async () => {
      first.latest().attachResolvedPaths(['/tmp/first.png'])
    })
    await act(async () => {
      second.latest().attachResolvedPaths(['/tmp/second.png'])
    })
    now.mockRestore()

    expect(first.latest().imageAttachments.map(({ path }) => path)).toEqual([
      '/tmp/first.png',
      '/tmp/second.png'
    ])
    act(() => first.root.unmount())
    act(() => second.root.unmount())
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
    expect(readNativeChatDraftAttachments('pty-1')).toMatchObject([])
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

  it('keeps a pending chip off disk and its preview in the pane that pasted it', async () => {
    const probe = await renderProbe('pty-1')
    const other = await renderProbe('pty-1')
    let pendingId: string | null = null
    act(() => {
      pendingId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/settled.png'])
    })
    act(() => window.dispatchEvent(new Event('pagehide')))

    const saved = JSON.parse(
      localStorage.getItem(`orca:nativeChatComposerDraft:v1:${encodeURIComponent('pty-1')}`) ??
        'null'
    )
    expect(saved?.attachments).toEqual([
      { id: expect.any(String), path: '/tmp/settled.png', location: 'local' }
    ])
    expect(probe.latest().imageAttachments).toContainEqual(
      expect.objectContaining({ id: pendingId, previewUrl: 'blob:preview-1', pending: true })
    )
    expect(other.latest().imageAttachments[0]).not.toHaveProperty('previewUrl')
    act(() => probe.root.unmount())
    act(() => other.root.unmount())
  })

  // Once the pasting pane is gone nothing else holds the URL, so a later remove could not free it.
  it("revokes a pane's blob previews when it unmounts, though its chips stay in the chat", async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const pasting = await renderProbe('session:chat-unmount', true)
    let id: string | null = null
    act(() => {
      id = pasting.latest().beginPendingImageAttachment('blob:pasted')
    })
    act(() => pasting.latest().resolvePendingImageAttachment(id ?? '', '/tmp/pasted.png'))

    act(() => pasting.root.unmount())

    expect(revoke).toHaveBeenCalledWith('blob:pasted')
    expect(readNativeChatDraftAttachments('session:chat-unmount')).toMatchObject([
      { path: '/tmp/pasted.png' }
    ])
    revoke.mockRestore()
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

describe('a restored draft whose image is gone', () => {
  afterEach(() => {
    clearNativeChatDraftCacheForTests()
    document.body.replaceChildren()
  })

  it('marks only a chip whose file is proven gone, checking each restored chip once', async () => {
    const pathsExist = vi.fn(
      async ({ filePaths, connectionId }: { filePaths: string[]; connectionId?: string }) =>
        // An unreachable host cannot say; that is not proof the file is gone.
        filePaths.map((path) =>
          connectionId ? { error: 'offline' } : { exists: path !== '/gone.png' }
        )
    )
    Object.defineProperty(window, 'api', { configurable: true, value: { fs: { pathsExist } } })
    addNativeChatDraftAttachments('session:restored', [
      { id: 'gone', path: '/gone.png', location: 'local' },
      { id: 'here', path: '/here.png', location: 'local' },
      { id: 'remote', path: '/remote.png', connectionId: 'ssh-1', location: 'ssh' },
      // A runtime server's path, or one saved before locations were recorded, means nothing here.
      { id: 'runtime', path: '/srv/gone.png', location: 'runtime' },
      { id: 'unknown', path: '/old/gone.png' }
    ])

    const probe = await renderProbe('session:restored', true)
    await act(async () => {})
    await act(async () => {
      probe.latest().attachResolvedPaths(['/new.png'])
    })

    expect(
      probe.latest().imageAttachments.map(({ path, missing }) => [path, missing === true])
    ).toEqual([
      ['/gone.png', true],
      ['/here.png', false],
      ['/remote.png', false],
      ['/srv/gone.png', false],
      ['/old/gone.png', false],
      ['/new.png', false]
    ])
    expect(pathsExist).toHaveBeenCalledTimes(2)
    expect(pathsExist).toHaveBeenCalledWith({ filePaths: ['/gone.png', '/here.png'] })
    expect(pathsExist).toHaveBeenCalledWith({ filePaths: ['/remote.png'], connectionId: 'ssh-1' })
    expect(readNativeChatDraftAttachments('session:restored')[0]).toEqual({
      id: 'gone',
      path: '/gone.png',
      location: 'local'
    })
    act(() => probe.root.unmount())
  })

  // The read grant made at attach lived in memory; without it a restored preview is blank and a
  // deleted original can never be shown missing.
  it('grants each restored local image before checking it, and holds its preview until then', async () => {
    const calls: string[] = []
    const answer = Promise.withResolvers<void>()
    const authorizeExternalPath = vi.fn(async ({ targetPath }: { targetPath: string }) => {
      calls.push(`grant ${targetPath}`)
    })
    const pathsExist = vi.fn(async ({ filePaths }: { filePaths: string[] }) => {
      calls.push(`check ${filePaths.join(',')}`)
      await answer.promise
      return filePaths.map(() => ({ exists: true }))
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { fs: { authorizeExternalPath, pathsExist } }
    })
    addNativeChatDraftAttachments('session:granted', [
      { id: 'local', path: '/Users/me/Desktop/shot.png', location: 'local' },
      { id: 'remote', path: '/remote.png', connectionId: 'ssh-1' }
    ])

    const probe = await renderProbe('session:granted', true)
    const checking = () => probe.latest().imageAttachments.map((chip) => chip.checking === true)
    expect(checking()).toEqual([true, true])
    await act(async () => answer.resolve())

    expect(authorizeExternalPath.mock.calls).toEqual([
      [{ targetPath: '/Users/me/Desktop/shot.png' }]
    ])
    expect(calls.indexOf('grant /Users/me/Desktop/shot.png')).toBeLessThan(
      calls.indexOf('check /Users/me/Desktop/shot.png')
    )
    expect(checking()).toEqual([false, false])
    act(() => probe.root.unmount())
  })
})
