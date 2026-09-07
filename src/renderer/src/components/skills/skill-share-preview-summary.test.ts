import { describe, expect, it } from 'vitest'
import type { SkillSharePreview } from '../../../../shared/skill-sharing-contract'
import { sensitiveShareFiles, summarizeShareRisk } from './skill-share-preview-summary'

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

describe('summarizeShareRisk', () => {
  it('reports the absence once instead of two zero counts', () => {
    expect(summarizeShareRisk(preview())).toEqual({
      risky: false,
      label: 'No scripts or executables'
    })
  })

  it('counts only the kinds that are present, with matching plurals', () => {
    expect(summarizeShareRisk(preview({ scriptPaths: ['scripts/a.sh'] })).label).toBe('1 script')
    expect(
      summarizeShareRisk(preview({ scriptPaths: ['scripts/a.sh', 'scripts/b.sh'] })).label
    ).toBe('2 scripts')
    expect(
      summarizeShareRisk(preview({ scriptPaths: ['scripts/a.sh'], executablePaths: ['bin/x'] }))
        .label
    ).toBe('1 script, 1 executable')
  })
})

describe('sensitiveShareFiles', () => {
  // Why: an executable script appears in both path sets; listing it twice would
  // overstate how much of the package can run.
  it('lists a file that is both script and executable once', () => {
    const files = sensitiveShareFiles(
      preview({ scriptPaths: ['scripts/setup.sh'], executablePaths: ['scripts/setup.sh'] })
    )
    expect(files).toEqual([{ path: 'scripts/setup.sh', script: true, executable: true }])
  })

  it('sorts paths so the same package always reviews in the same order', () => {
    const files = sensitiveShareFiles(
      preview({ scriptPaths: ['scripts/b.sh', 'scripts/a.sh'], executablePaths: ['bin/tool'] })
    )
    expect(files.map((file) => file.path)).toEqual(['bin/tool', 'scripts/a.sh', 'scripts/b.sh'])
  })
})
