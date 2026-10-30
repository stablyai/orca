import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import * as correspondence from '../../../../shared/ai-vault-session-cwd-aliases'
import { resolveAiVaultSessionResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import {
  aiVaultSearchHitToSession,
  canResumeAiVaultSearchHit,
  hasAiVaultSearchHitPath,
  withAiVaultHistoryPreviews
} from './ai-vault-search-session'

afterEach(() => vi.restoreAllMocks())

describe('withAiVaultHistoryPreviews', () => {
  it('bounds identity indexing and correspondence work when history adds aliases at N and 10N', () => {
    const copy = vi.spyOn(correspondence, 'withAiVaultSessionCwdAliases')
    for (const size of [100, 1000]) {
      let identityReads = 0
      const hits = Array.from({ length: size }, (_, index) => {
        const row = aiVaultSearchHitToSession(
          { ...searchHit(), sessionId: `session-${index}`, cwd: '/private/var/example' },
          'local'
        )
        return {
          ...row,
          get sessionId() {
            identityReads += 1
            return row.sessionId
          }
        }
      })
      const history = hits.map((hit) => ({ ...hit }))
      expect(withAiVaultHistoryPreviews(hits, history).every((row) => !row.cwdAliases)).toBe(true)
      const updated = history.map((row) => ({
        ...row,
        cwdAliases: ['/var/example'],
        get sessionId() {
          identityReads += 1
          return row.sessionId
        }
      }))
      identityReads = 0
      copy.mockClear()
      const hydrated = withAiVaultHistoryPreviews(hits, updated)
      expect(hydrated.every((row) => row.cwdAliases?.[0] === '/var/example')).toBe(true)
      expect(copy).toHaveBeenCalledTimes(size)
      expect(identityReads).toBeGreaterThanOrEqual(2 * size)
      expect(identityReads).toBeLessThanOrEqual(4 * size)
    }
  })

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

  it("shows a paired server hit's conversation preview from its scanned history row", () => {
    // A relay hit arrives without its transcript path, so its row id differs from the scanned row's.
    const hitSession = aiVaultSearchHitToSession(
      { ...searchHit(), source: { presence: 'present' as const } },
      'runtime:env-1'
    )
    const turns = [
      { role: 'user' as const, text: 'Fix the flaky test', timestamp: null },
      { role: 'assistant' as const, text: 'Done', timestamp: null }
    ]

    const [hydrated] = withAiVaultHistoryPreviews(
      [hitSession],
      [
        {
          ...hitSession,
          id: 'runtime:env-1:codex:host-session:/host/transcript.jsonl',
          filePath: '/host/transcript.jsonl',
          previewMessages: turns,
          firstUserPrompt: 'Fix the flaky test'
        }
      ]
    )

    expect(hydrated.previewMessages).toEqual(turns)
    expect(hydrated.firstUserPrompt).toBe('Fix the flaky test')
    expect(hydrated.resumeCommand).toBe('host-resume-command')
  })
})

describe('aiVaultSearchHitToSession', () => {
  it('uses the selected execution host and only host-provided source fields', () => {
    const hit = { ...searchHit(), executionHostId: 'local' }
    const session = aiVaultSearchHitToSession(hit, 'ssh:paired-host')

    expect(session.executionHostId).toBe('ssh:paired-host')
    expect(session.id).toBe('ssh:paired-host:codex:host-session:/host/transcript.jsonl')
    expect(session.filePath).toBe('/host/transcript.jsonl')
    expect(session.resumeCommand).toBe('host-resume-command')
    expect(session.previewMessages).toEqual([])
  })

  it('does not invent a path or resume command when transport withholds them', () => {
    const hit = {
      ...searchHit(),
      source: { presence: 'unverifiable' as const },
      resumeCommand: undefined
    }
    const session = aiVaultSearchHitToSession(hit, 'runtime:cloud')

    expect(session.filePath).toBe('')
    expect(session.resumeCommand).toBe('')
    expect(canResumeAiVaultSearchHit(hit)).toBe(false)
    expect(hasAiVaultSearchHitPath(hit)).toBe(false)
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

  it('gates resume and path actions on their own source fields', () => {
    const withoutResume = { ...searchHit(), resumeCommand: undefined }

    expect(canResumeAiVaultSearchHit(withoutResume)).toBe(false)
    expect(hasAiVaultSearchHitPath(withoutResume)).toBe(true)
  })
})
