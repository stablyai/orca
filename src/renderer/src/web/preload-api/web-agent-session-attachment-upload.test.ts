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

import { saveClipboardImageAsWebAgentSessionAttachment } from './web-agent-session-attachment-upload'

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
