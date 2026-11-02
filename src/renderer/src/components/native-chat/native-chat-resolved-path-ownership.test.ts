import { expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'

import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { resolveNativeChatRuntimeSessionAttachmentOwner } from './native-chat-attachment-upload'
it.each([false, true])(
  'accepts an upload after re-pair only with proven host continuity=%s',
  (sameHost) => {
    replaceRuntimeEnvironmentRevisions([{ id: 'e1', createdAt: 1, pairingRevision: 7 }])
    const resolve = () =>
      resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: 's1',
        runtimeEnvironmentId: 'e1'
      })
    const captured = resolve()
    replaceRuntimeEnvironmentRevisions([{ id: 'e1', createdAt: 1, pairingRevision: 8 }], {
      retired: sameHost ? [] : ['e1'],
      sameHost: sameHost ? [{ id: 'e1', fromRevision: 7, toRevision: 8 }] : []
    })
    expect(nativeChatAttachmentOwnerUnchanged(captured, resolve())).toBe(sameHost)
    replaceRuntimeEnvironmentRevisions([])
  }
)
