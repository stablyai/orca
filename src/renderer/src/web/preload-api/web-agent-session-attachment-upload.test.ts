import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestEnvironment = { id: string; createdAt: number; pairingRevision?: number }

const mocks = vi.hoisted(() => {
  const activeEnvironment: TestEnvironment = { id: 'env-1', createdAt: 1, pairingRevision: 7 }
  return { callEnvironmentEnvelope: vi.fn(), activeEnvironment }
})

vi.mock('./web-runtime-calls', () => ({ callEnvironmentEnvelope: mocks.callEnvironmentEnvelope }))
vi.mock('./web-runtime-session', () => ({
  resolveEnvironment: (selector: string) => {
    if (selector !== mocks.activeEnvironment.id) {
      throw new Error(`Unknown Orca runtime environment: ${selector}`)
    }
    return mocks.activeEnvironment
  }
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'uuid-1' }))

import { uploadBrowserFilesToWebAgentSessionAttachments } from './web-agent-session-attachment-upload'
import { holdBrowserAttachmentFiles } from '@/lib/browser-attachment-files'
import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../shared/agent-session/agent-session-attachments'

const target = {
  environmentId: 'env-1',
  sessionId: 'session-1',
  expectedEnvironmentPairingRevision: 7,
  expectedEnvironmentRuntimeId: 'runtime-a'
}

function reply(result: unknown, runtimeId = 'runtime-a') {
  return { id: 'r', ok: true, result, _meta: { runtimeId } }
}

beforeEach(() => {
  mocks.callEnvironmentEnvelope.mockReset()
  mocks.activeEnvironment = { id: 'env-1', createdAt: 1, pairingRevision: 7 }
})

describe('uploadBrowserFilesToWebAgentSessionAttachments', () => {
  it('uploads a held browser file chunk by chunk at byte offsets and reports its stored path', async () => {
    const appends: { offset: number; contentBase64: string }[] = []
    mocks.callEnvironmentEnvelope.mockImplementation(
      async (_env: string, method: string, params: { offset: number; contentBase64: string }) => {
        if (method === 'agentSessionAttachment.uploadStart') {
          return reply({ uploadId: 'u1' })
        }
        if (method === 'agentSessionAttachment.uploadAppend') {
          appends.push({ offset: params.offset, contentBase64: params.contentBase64 })
          return reply({ receivedBytes: 0 })
        }
        return reply({ path: '/srv/agent-session-attachments/u1/notes.txt', name: 'notes.txt' })
      }
    )
    const bytes = Buffer.alloc(AGENT_SESSION_ATTACHMENT_CHUNK_BYTES + 5, 7)
    const [token] = holdBrowserAttachmentFiles([new File([bytes], 'notes.txt')])

    const result = await uploadBrowserFilesToWebAgentSessionAttachments({
      ...target,
      paths: [token!, 'orca-browser-file:gone/old.txt']
    })

    expect(token).toMatch(/\/notes\.txt$/)
    expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledWith(
      'env-1',
      'agentSessionAttachment.uploadStart',
      { sessionId: 'session-1', name: 'notes.txt', byteLength: bytes.length },
      expect.any(Number)
    )
    expect(appends.map(({ offset }) => offset)).toEqual([0, AGENT_SESSION_ATTACHMENT_CHUNK_BYTES])
    expect(
      Buffer.concat(appends.map(({ contentBase64 }) => Buffer.from(contentBase64, 'base64')))
    ).toEqual(bytes)
    expect(result.uploaded).toEqual([
      { sourcePath: token, path: '/srv/agent-session-attachments/u1/notes.txt' }
    ])
    // A token is claimed once; one nothing holds fails instead of attaching nothing silently.
    expect(result.failed.map(({ sourcePath }) => sourcePath)).toEqual([
      'orca-browser-file:gone/old.txt'
    ])
  })
})
