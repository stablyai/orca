// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { refreshAiVaultSessionList } from './ai-vault-session-list-request'

const session: AiVaultSession = {
  id: 'runtime:one:codex:session:/session.jsonl',
  executionHostId: 'runtime:one',
  agent: 'codex',
  sessionId: 'session',
  title: 'Previous conversation',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/session.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: 'date',
  messageCount: 1,
  totalTokens: 42,
  previewMessages: [{ role: 'user', text: 'Retain this prompt', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume session',
  subagent: null
}
const fingerprint = 'a'.repeat(64)
const previous: AiVaultListResult = {
  sessions: [session],
  issues: [],
  scannedAt: 'old',
  fingerprint
}
const request = {
  executionHostScope: 'runtime:one' as const,
  scopePaths: ['/repo'],
  sessionLimit: 250
}
const options = { requestToken: 'panel' }
const compact: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: 'fresh',
  fingerprint,
  unchanged: true
}

function transport() {
  const listSessions = vi.fn<(args: unknown) => Promise<AiVaultListResult>>()
  vi.stubGlobal('window', { api: { aiVault: { listSessions } } })
  return listSessions
}
afterEach(() => vi.unstubAllGlobals())

describe('selected-runtime conditional refresh', () => {
  it('reuses the exact captured body, previews and metadata without clearing history', async () => {
    const list = transport().mockResolvedValue(compact)
    const result = await refreshAiVaultSessionList(request, options, {
      fingerprint,
      result: previous
    })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ afterFingerprint: fingerprint }))
    expect(result.sessions).toBe(previous.sessions)
    expect(result.sessions[0]?.previewMessages).toBe(session.previewMessages)
    expect(result.issues).toBe(previous.issues)
    expect(result.scannedAt).toBe('fresh')
    expect(result.unchanged).toBeUndefined()
  })

  it('opts in initially and keeps old-server full replies', async () => {
    const list = transport().mockResolvedValue(previous)
    expect(await refreshAiVaultSessionList(request, options)).toBe(previous)
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ afterFingerprint: null }))
  })

  it.each(['all', 'local', 'ssh:one'] as const)(
    'keeps %s refreshes on the full-response path',
    async (scope) => {
      const list = transport().mockResolvedValue(previous)
      await refreshAiVaultSessionList({ ...request, executionHostScope: scope }, options)
      expect(list.mock.calls[0]?.[0]).not.toHaveProperty('afterFingerprint')
    }
  )

  it('keeps unlimited history on the full path without changing its requested depth', async () => {
    const list = transport().mockResolvedValue(previous)
    await refreshAiVaultSessionList({ ...request, sessionLimit: 'unlimited' }, options, {
      fingerprint,
      result: previous
    })
    expect(list.mock.calls[0]?.[0]).toMatchObject({ unlimited: true })
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty('afterFingerprint')
  })

  it('falls back to a full fetch when a marker has no matching owned body', async () => {
    const list = transport().mockResolvedValueOnce(compact).mockResolvedValueOnce(previous)
    expect(await refreshAiVaultSessionList(request, options)).toBe(previous)
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1]?.[0]).not.toHaveProperty('afterFingerprint')
  })

  it('rejects repeated invalid markers rather than displaying empty history', async () => {
    transport().mockResolvedValue(compact)
    await expect(refreshAiVaultSessionList(request, options)).rejects.toThrow('full history')
  })

  it("uses each concurrent caller's captured body when replies settle out of order", async () => {
    const finishes: ((result: AiVaultListResult) => void)[] = []
    transport().mockImplementation(() => new Promise((resolve) => finishes.push(resolve)))
    const other = { ...previous, sessions: [{ ...session, title: 'Other host' }] }
    const first = refreshAiVaultSessionList(request, options, { fingerprint, result: previous })
    const second = refreshAiVaultSessionList(
      { ...request, executionHostScope: 'runtime:two' },
      options,
      { fingerprint, result: other }
    )
    finishes[1](compact)
    expect((await second).sessions).toBe(other.sessions)
    finishes[0](compact)
    expect((await first).sessions).toBe(previous.sessions)
  })
})
