import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSessionTitlesResult } from '../../../../shared/ai-vault-session-title'
import {
  subscribeAiVaultStructuredTitles,
  cacheAiVaultSessionResult,
  readAiVaultSessionResultSnapshot
} from './ai-vault-session-result-cache'
import { resetAiVaultForcedRescanThrottleForTest } from './ai-vault-session-refresh'
import { recoverAiVaultStructuredTitles } from './ai-vault-structured-title-recovery'
import { session, result } from './ai-vault-structured-title-fixtures'

const resolve = vi.fn<(args: unknown) => Promise<AiVaultSessionTitlesResult>>()
const owner = { workspaceId: 'folder-workspace', sessionId: 'native-session' }
function cache(host: 'local' | 'runtime:paired-host' = 'local', count = 1): void {
  const row = session(host)
  cacheAiVaultSessionResult({
    key: 'recovery',
    executionHostScope: host,
    limit: 'unlimited',
    replaceHostEntries: false,
    result: {
      ...result(row),
      sessions: Array.from({ length: count }, (_, index) =>
        index === 0
          ? row
          : {
              ...row,
              id: `${host}:row-${index}`,
              sessionId: `provider-${index}`,
              structuredSession: { ...owner, sessionId: `native-${index}` }
            }
      )
    }
  })
}
function reply(title = 'Recovered record name'): AiVaultSessionTitlesResult {
  return {
    titles: [{ agent: 'codex', sessionId: 'provider-session', title, structuredSession: owner }]
  }
}
beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  resolve.mockReset().mockResolvedValue(reply())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { resolveSessionTitles: resolve } }
  })
})
afterEach(() => resetAiVaultForcedRescanThrottleForTest())
it('repairs only cached exact owners and batches more than 64 native rows', async () => {
  cache('local', 65)
  await recoverAiVaultStructuredTitles('local', () => true)
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({
    executionHostScope: 'local',
    requests: expect.any(Array)
  })
  const first = resolve.mock.calls[0]?.[0]
  if (
    typeof first !== 'object' ||
    first === null ||
    !('requests' in first) ||
    !Array.isArray(first.requests)
  ) {
    throw new Error('Missing bounded requests')
  }
  expect(first.requests).toHaveLength(64)
  expect(first.requests[0]).toEqual({
    agent: 'codex',
    sessionId: 'provider-session',
    structuredSession: owner
  })
  expect(readAiVaultSessionResultSnapshot('recovery')?.sessions[0]?.title).toBe(
    'Recovered record name'
  )
  await recoverAiVaultStructuredTitles('runtime:paired-host', () => true)
  expect(resolve).toHaveBeenCalledTimes(2)
})
it.each([
  { agent: 'codex' as const, sessionId: 'provider-session', title: 'Old prompt' },
  {
    agent: 'claude' as const,
    sessionId: 'provider-session',
    title: 'Wrong provider',
    structuredSession: owner
  },
  { ...reply().titles[0]!, sessionId: 'wrong-provider-id' },
  { ...reply().titles[0]!, structuredSession: { ...owner, workspaceId: 'wrong-workspace' } },
  { ...reply().titles[0]!, structuredSession: { ...owner, sessionId: 'wrong-record' } },
  { ...reply().titles[0]!, title: 'Malformed\nName' }
])('ignores old or mismatched native provenance: %j', async (title) => {
  cache()
  resolve.mockResolvedValueOnce({ titles: [title] })
  await recoverAiVaultStructuredTitles('local', () => true)
  expect(readAiVaultSessionResultSnapshot('recovery')?.sessions[0]?.title).toBe('Codex Chat')
})
it('drops late generation and changed owner replies, and coalesces lifecycle bursts', async () => {
  cache()
  const first = Promise.withResolvers<AiVaultSessionTitlesResult>()
  resolve.mockReturnValueOnce(first.promise)
  let current = true
  const pending = recoverAiVaultStructuredTitles('local', () => current)
  const queued = Array.from({ length: 12 }, () =>
    recoverAiVaultStructuredTitles('local', () => true)
  )
  current = false
  first.resolve(reply('Stale generation'))
  await Promise.all([pending, ...queued])
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(readAiVaultSessionResultSnapshot('recovery')?.sessions[0]?.title).toBe(
    'Recovered record name'
  )
  const late = Promise.withResolvers<AiVaultSessionTitlesResult>()
  resolve.mockReturnValueOnce(late.promise)
  const changed = recoverAiVaultStructuredTitles('local', () => true)
  const row = { ...session(), structuredSession: { ...owner, sessionId: 'replacement-session' } }
  cacheAiVaultSessionResult({
    key: 'recovery',
    executionHostScope: 'local',
    limit: 'unlimited',
    replaceHostEntries: true,
    result: result(row)
  })
  late.resolve(reply('Wrong old owner'))
  await changed
  expect(readAiVaultSessionResultSnapshot('recovery')?.sessions[0]?.title).toBe('Codex Chat')
})
it('ends a failed or cancelled repair and starts only on the next lifecycle request', async () => {
  cache()
  resolve.mockRejectedValueOnce(new Error('Offline'))
  await recoverAiVaultStructuredTitles('local', () => true)
  expect(resolve).toHaveBeenCalledTimes(1)
  await recoverAiVaultStructuredTitles('local', () => false)
  expect(resolve).toHaveBeenCalledTimes(1)
  await recoverAiVaultStructuredTitles('local', () => true)
  expect(resolve).toHaveBeenCalledTimes(2)
})

it('publishes a whole repair once and visits cache rows linearly across bounded batches', async () => {
  let reads = 0
  const rows = Array.from({ length: 65 }, (_, index) => {
    const row = {
      ...session(),
      id: `row-${index}`,
      sessionId: `provider-${index}`,
      structuredSession: { ...owner, sessionId: `native-${index}` }
    }
    const identity = row.structuredSession
    Object.defineProperty(row, 'structuredSession', {
      enumerable: true,
      get: () => {
        reads++
        return identity
      }
    })
    return row
  })
  cacheAiVaultSessionResult({
    key: 'recovery',
    executionHostScope: 'local',
    limit: 'unlimited',
    replaceHostEntries: true,
    result: { ...result(), sessions: rows }
  })
  resolve.mockImplementation(async (args) => {
    if (
      typeof args !== 'object' ||
      args === null ||
      !('requests' in args) ||
      !Array.isArray(args.requests)
    ) {
      throw new Error('Missing requests')
    }
    return { titles: args.requests.map((request) => ({ ...request, title: 'Recovered' })) }
  })
  const published = vi.fn()
  const stop = subscribeAiVaultStructuredTitles(published)
  try {
    await recoverAiVaultStructuredTitles('local', () => true)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(published).toHaveBeenCalledTimes(1)
    expect(reads).toBeLessThan(rows.length * 30)
    expect(
      readAiVaultSessionResultSnapshot('recovery')?.sessions.every(
        (row) => row.title === 'Recovered'
      )
    ).toBe(true)
  } finally {
    stop()
  }
})
it('fences paired cache-entry repairs when pairing changes although the panel stays current', async () => {
  cache('runtime:paired-host')
  replaceRuntimeEnvironmentRevisions([{ id: 'paired-host', createdAt: 1 }])
  const late = Promise.withResolvers<AiVaultSessionTitlesResult>()
  resolve.mockReturnValueOnce(late.promise)
  const pending = recoverAiVaultStructuredTitles('runtime:paired-host', () => true)
  replaceRuntimeEnvironmentRevisions([{ id: 'paired-host', createdAt: 2 }])
  late.resolve(reply('Previous pairing'))
  await pending
  expect(readAiVaultSessionResultSnapshot('recovery')?.sessions[0]?.title).toBe('Codex Chat')
  replaceRuntimeEnvironmentRevisions([])
})

it('rejects a late reply after the provider session changes under the same native owner', async () => {
  cache()
  const late = Promise.withResolvers<AiVaultSessionTitlesResult>()
  resolve.mockReturnValueOnce(late.promise)
  const pending = recoverAiVaultStructuredTitles('local', () => true)
  const replacement = { ...session(), sessionId: 'replacement-provider' }
  cacheAiVaultSessionResult({
    key: 'recovery',
    executionHostScope: 'local',
    limit: 'unlimited',
    replaceHostEntries: true,
    result: result(replacement)
  })
  late.resolve(reply('Old provider reply'))
  await pending
  expect(readAiVaultSessionResultSnapshot('recovery')?.sessions[0]?.title).toBe('Codex Chat')
})
