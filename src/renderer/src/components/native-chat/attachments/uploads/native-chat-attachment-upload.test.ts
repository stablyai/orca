import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

import { prepareNativeChatSessionAttachmentUpload } from './native-chat-session-attachment-upload'

import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

describe('a structured chat on a paired server', () => {
  const owner = {
    kind: 'runtime-session' as const,
    environmentId: 'env-1',
    pairingRevision: 7,
    sessionId: 'session-1'
  }

  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 7 }])
    mocks.callRuntimeRpc.mockReset()
  })

  it('tells the user to update an older server instead of uploading', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ runtimeId: 'runtime-a', capabilities: [] })
    await expect(prepareNativeChatSessionAttachmentUpload(owner)).resolves.toEqual({
      ok: false,
      notice:
        'This needs a newer Orca on the computer running this chat. Update Orca there, then try again.'
    })
  })
})
