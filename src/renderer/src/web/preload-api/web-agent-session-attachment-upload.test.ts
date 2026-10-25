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

import {
  saveClipboardImageAsWebAgentSessionAttachment,
  uploadBrowserFilesToWebAgentSessionAttachments
} from './web-agent-session-attachment-upload'
import { holdBrowserAttachmentFiles } from '@/lib/browser-attachment-files'
import { AGENT_SESSION_ATTACHMENT_CHUNK_BYTES } from '../../../../shared/agent-session-attachments'

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

describe('saveClipboardImageAsWebAgentSessionAttachment', () => {
  it('uploads to the server the paste was meant for and returns its stored path', async () => {
    mocks.callEnvironmentEnvelope.mockImplementation(async (_env: string, method: string) =>
      method === 'agentSessionAttachment.uploadStart'
        ? reply({ uploadId: 'u1' })
        : method === 'agentSessionAttachment.uploadCommit'
          ? reply({ path: '/srv/agent-session-attachments/u1/p.png', name: 'p.png', byteLength: 3 })
          : reply({ receivedBytes: 3 })
    )
    await expect(
      saveClipboardImageAsWebAgentSessionAttachment(Buffer.from('png').toString('base64'), target)
    ).resolves.toBe('/srv/agent-session-attachments/u1/p.png')
    for (const call of mocks.callEnvironmentEnvelope.mock.calls) {
      expect(call[0]).toBe('env-1')
    }
  })

  it('stops when a different server process answers, storing nothing more', async () => {
    mocks.callEnvironmentEnvelope.mockResolvedValue(reply({ uploadId: 'u1' }, 'runtime-b'))
    await expect(
      saveClipboardImageAsWebAgentSessionAttachment(Buffer.from('png').toString('base64'), target)
    ).rejects.toThrow('paired Orca server changed')
    expect(mocks.callEnvironmentEnvelope).toHaveBeenCalledTimes(1)
  })

  it('refuses before uploading once the server was re-paired', async () => {
    mocks.activeEnvironment = { id: 'env-1', createdAt: 1, pairingRevision: 8 }
    await expect(
      saveClipboardImageAsWebAgentSessionAttachment(Buffer.from('png').toString('base64'), target)
    ).rejects.toThrow('paired Orca server changed')
    expect(mocks.callEnvironmentEnvelope).not.toHaveBeenCalled()
  })

  it('refuses when the paste was meant for a server this client no longer pairs with', async () => {
    await expect(
      saveClipboardImageAsWebAgentSessionAttachment(Buffer.from('png').toString('base64'), {
        ...target,
        environmentId: 'env-other'
      })
    ).rejects.toThrow('Unknown Orca runtime environment')
    expect(mocks.callEnvironmentEnvelope).not.toHaveBeenCalled()
  })
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
