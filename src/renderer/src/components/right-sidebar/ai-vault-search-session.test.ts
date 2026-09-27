import { describe, expect, it } from 'vitest'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import {
  aiVaultSearchHitToSession,
  canResumeAiVaultSearchHit,
  hasAiVaultSearchHitPath
} from './ai-vault-search-session'

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

  it('gates resume and path actions on their own source fields', () => {
    const withoutResume = { ...searchHit(), resumeCommand: undefined }

    expect(canResumeAiVaultSearchHit(withoutResume)).toBe(false)
    expect(hasAiVaultSearchHitPath(withoutResume)).toBe(true)
  })
})
