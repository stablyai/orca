// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderProbe } from './native-chat-composer-attachments-test-probe'
import { readNativeChatAttachmentCache } from './native-chat-attachment-draft'

import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { readNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

import { useAppStore } from '@/store'

const initialStoreState = useAppStore.getInitialState()

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
const runtimeTarget = vi.hoisted(() => ({ remote: false }))
vi.mock(
  '../../../../../../shared/remote-runtime/remote-runtime-pty-id',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
    isRemoteRuntimePtyId: () => runtimeTarget.remote
  })
)

describe('useNativeChatComposerAttachments', () => {
  afterEach(() => {
    useAppStore.setState(initialStoreState, true)
    runtimeTarget.remote = false
    document.body.replaceChildren()
  })

  it('attaches a dropped BMP as a file reference, since agents take only PNG, JPEG, GIF and WebP inline', async () => {
    const probe = await renderProbe('pty-bmp')
    act(() => probe.latest().attachResolvedPaths(['/repo/diagram.bmp', '/repo/shot.png']))

    expect(probe.latest().imageAttachments).toMatchObject([{ path: '/repo/shot.png' }])
    expect(probe.draft()).toContain('@/repo/diagram.bmp')
    act(() => probe.root.unmount())
  })

  it('keeps images outside prompt text and retains attachments when text is cleared', async () => {
    const probe = await renderProbe('image-tray', true)
    act(() => probe.latest().adoptDraft('Describe these images'))
    const begun: { kept?: string | null; removed?: string | null } = {}
    act(() => {
      begun.kept = probe.latest().beginPendingImageAttachment()
      begun.removed = probe.latest().beginPendingImageAttachment()
    })
    if (!begun.kept || !begun.removed) {
      throw new Error('expected pending images')
    }
    expect(probe.draft()).toBe('Describe these images')
    expect(probe.latest().imageAttachments.map(({ id }) => id)).toEqual([begun.kept, begun.removed])
    act(() => probe.latest().removeImageAttachment(begun.removed!))
    expect(probe.draft()).toBe('Describe these images')
    act(() => probe.latest().adoptDraft(''))
    expect(probe.latest().imageAttachments.map(({ id }) => id)).toEqual([begun.kept])
    act(() => probe.root.unmount())
  })

  it('settles a late image upload in its own chat without inserting prompt markers', async () => {
    const probe = await renderProbe('image-chat-a', true)
    const fromA = probe.latest()
    const pending: { id?: string | null } = {}
    act(() => {
      pending.id = fromA.beginPendingImageAttachment()
    })
    if (!pending.id) {
      throw new Error('expected a pending image')
    }
    await probe.rerender('image-chat-b')
    act(() => probe.latest().adoptDraft('B draft'))
    act(() => fromA.resolvePendingImageAttachment(pending.id!, '/up/a.png'))
    expect(readNativeChatComposerDraft('image-chat-a')).toMatchObject({
      text: '',
      images: [{ id: pending.id, path: '/up/a.png' }]
    })
    expect(probe.draft()).toBe('B draft')
    act(() => probe.root.unmount())
  })

  it('clears a pending image on disable without putting its marker in prompt text', async () => {
    const probe = await renderProbe('structured-1', true)
    act(() => {
      probe.latest().beginPendingImageAttachment()
    })
    expect(probe.latest().imageAttachments).toMatchObject([{ pending: true }])
    expect(readNativeChatDraftCache('structured-1')).toBe('')

    await probe.rerender('structured-1', true)
    expect(probe.latest().imageAttachments).toEqual([])
    expect(readNativeChatDraftCache('structured-1')).toBe('')
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
})
