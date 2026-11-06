import { describe, expect, it } from 'vitest'
import type { SkillSharePreview } from '../../../../shared/skill-sharing-contract'
import { sensitiveShareFiles } from './skill-share-preview-summary'

function preview(overrides: Partial<SkillSharePreview> = {}): SkillSharePreview {
  return {
    preparationId: 'prep',
    packageId: 'pkg',
    versionId: 'ver',
    name: 'skill',
    description: 'A skill',
    packageDigest: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    fileCount: 2,
    totalBytes: 2048,
    compressedBytes: 1024,
    scriptPaths: [],
    executablePaths: [],
    expiresAt: '2026-08-11T01:00:00.000Z',
    ...overrides
  }
}

describe('sensitiveShareFiles', () => {
  it('lists a file that is both script and executable once', () => {
    const files = sensitiveShareFiles(
      preview({ scriptPaths: ['scripts/setup.sh'], executablePaths: ['scripts/setup.sh'] })
    )
    expect(files).toEqual([{ path: 'scripts/setup.sh', script: true, executable: true }])
  })
})
