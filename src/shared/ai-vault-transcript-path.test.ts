import { describe, expect, it } from 'vitest'
import { getAiVaultTranscriptPath } from './ai-vault-transcript-path'

describe('getAiVaultTranscriptPath', () => {
  it('uses an explicit transcript path', () => {
    expect(
      getAiVaultTranscriptPath({
        filePath: '/metadata/meta.json',
        transcriptFilePath: '/logs/session.jsonl'
      })
    ).toBe('/logs/session.jsonl')
  })

  it('hides logs when the producer explicitly reports no transcript', () => {
    expect(
      getAiVaultTranscriptPath({
        filePath: '/metadata/meta.json',
        transcriptFilePath: null
      })
    ).toBeNull()
  })

  it('falls back to filePath for older producers', () => {
    expect(getAiVaultTranscriptPath({ filePath: '/legacy/session.jsonl' })).toBe(
      '/legacy/session.jsonl'
    )
  })
})
