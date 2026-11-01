import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

import { prepareNativeChatSessionAttachmentUpload } from './native-chat-attachment-upload'

import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

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

  it('asks the server, pinned to the pairing, and uploads only where it keeps a store', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      runtimeId: 'runtime-a',
      capabilities: [AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY]
    })
    await expect(prepareNativeChatSessionAttachmentUpload(owner)).resolves.toEqual({
      ok: true,
      target: {
        environmentId: 'env-1',
        sessionId: 'session-1',
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'runtime-a'
      }
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'status.get',
      undefined,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
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
