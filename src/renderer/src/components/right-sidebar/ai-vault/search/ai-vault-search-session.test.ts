import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'

import { resolveAiVaultSessionResumeInChatEligibility } from '../session-actions/ai-vault-session-resume-in-chat'
import {
  aiVaultSearchHitToSession,
  canResumeAiVaultSearchHit,
  hasAiVaultSearchHitPath,
  withAiVaultHistoryPreviews
} from './ai-vault-search-session'

afterEach(() => vi.restoreAllMocks())

describe('withAiVaultHistoryPreviews', () => {
  it('restores resume correspondence when history arrives after a search hit, even with an existing preview', () => {
    const hit = aiVaultSearchHitToSession(
      { ...searchHit(), agent: 'claude', cwd: '/private/var/example' },
      'local'
    )
    const previewed = {
      ...hit,
      previewMessages: [{ role: 'user' as const, text: 'Keep this preview', timestamp: null }]
    }
    const history = { ...hit, cwdAliases: ['/var/example'] }
    const resume = (session: typeof hit) =>
      resolveAiVaultSessionResumeInChatEligibility({
        session,
        targetWorkspaceId: 'folder:example',
        targetWorkspacePath: '/var/example',
        structuredRouteAvailable: true
      })
    expect(resume(withAiVaultHistoryPreviews([previewed], [])[0]).available).toBe(false)
    const [hydrated] = withAiVaultHistoryPreviews([previewed], [history])
    expect(hydrated.previewMessages).toBe(previewed.previewMessages)
    expect(resume(hydrated)).toEqual({ available: true, workspaceId: 'folder:example' })
    const redacted = { ...hit, filePath: '' }
    expect(resume(withAiVaultHistoryPreviews([redacted], [history])[0]).available).toBe(true)
    for (const rows of [
      [history, { ...history, id: 'duplicate' }],
      [{ ...history, cwd: '/private/var/different' }],
      [{ ...history, filePath: '/other-transcript' }],
      [{ ...history, executionHostId: 'runtime:other' as const }]
    ]) {
      expect(withAiVaultHistoryPreviews([hit], rows)[0].cwdAliases).toBeUndefined()
    }
  })
})

describe('aiVaultSearchHitToSession', () => {
  it('uses the selected execution host and only host-provided source fields', () => {
    const hit = {
      ...searchHit(),
      executionHostId: 'local',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/recorded' },
      accountWslDistro: 'Ubuntu'
    }
    const session = aiVaultSearchHitToSession(hit, 'ssh:paired-host')

    expect(session.executionHostId).toBe('ssh:paired-host')
    expect(session.id).toBe('ssh:paired-host:codex:host-session:/host/transcript.jsonl')
    expect(session.filePath).toBe('/host/transcript.jsonl')
    expect(session.resumeCommand).toBe('host-resume-command')
    expect(session.previewMessages).toEqual([])
    expect(session.accountHome).toEqual(hit.accountHome)
    expect(session.accountWslDistro).toBe('Ubuntu')
  })

  it('opens a native chat hit through its owner when transport withholds the command', () => {
    const hit = {
      ...searchHit(),
      source: { presence: 'present' as const },
      resumeCommand: undefined,
      structuredSession: { sessionId: 'native-session', workspaceId: 'host-workspace' }
    }

    expect(canResumeAiVaultSearchHit(hit)).toBe(true)
    expect(hasAiVaultSearchHitPath(hit)).toBe(false)
  })
})
