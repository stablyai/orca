// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderProbe } from './native-chat-composer-attachments-test-probe'
import { clearNativeChatAttachmentCacheForTests } from '../../drafts/native-chat-draft-reset'
import { readNativeChatAttachmentCache } from './native-chat-attachment-draft'

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
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
  })

  it('attaches a dropped BMP as a file reference, since agents take only PNG, JPEG, GIF and WebP inline', async () => {
    const probe = await renderProbe('pty-bmp')
    act(() => probe.latest().attachResolvedPaths(['/repo/diagram.bmp', '/repo/shot.png']))

    expect(probe.latest().imageAttachments).toMatchObject([{ path: '/repo/shot.png' }])
    expect(probe.draft()).toContain('@/repo/diagram.bmp')
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
