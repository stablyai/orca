import { describe, expect, it } from 'vitest'
import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import { checklistItemSummary, checklistItemsFromVersion } from './skill-package-checklist-items'

type ManifestFile = {
  path: string
  size: number
  executable: boolean
  classification: 'binary' | 'text'
  sha256: string
  identitySha256: string
}

function file(path: string, executable = false): ManifestFile {
  return {
    path,
    size: 1024,
    executable,
    classification: 'text' as const,
    sha256: 'a'.repeat(64),
    identitySha256: 'a'.repeat(64)
  }
}

function singleVersion(): SkillCloudVersion {
  return {
    packageId: 'pkg_1',
    versionId: 'ver_1',
    name: 'published-name',
    description: 'Published description',
    packageDigest: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    compressedBytes: 128,
    createdAt: '2026-08-11T00:00:00.000Z',
    releaseNotes: '',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_1',
      versionId: 'ver_1',
      name: 'manifest-name',
      description: 'Manifest description',
      createdAt: '2026-08-11T00:00:00.000Z',
      files: [file('SKILL.md')],
      packageDigest: 'a'.repeat(64)
    }
  }
}

describe('checklistItemsFromVersion', () => {
  // Why: one shape for both package kinds keeps the dialog's list identical
  // whether the link holds one skill or thirty.
  it('turns a single-skill package into a one-row checklist', () => {
    expect(checklistItemsFromVersion(singleVersion())).toEqual([
      {
        id: 'manifest-name',
        name: 'published-name',
        description: 'Published description',
        files: [file('SKILL.md')]
      }
    ])
  })

  it('keeps each bundled skill as its own row', () => {
    const bundled = {
      ...singleVersion(),
      manifest: {
        schemaVersion: 1 as const,
        packageId: 'pkg_1',
        versionId: 'ver_1',
        bundleName: 'shared-skills',
        description: 'Synthetic bundle description',
        createdAt: '2026-08-11T00:00:00.000Z',
        bundleDigest: 'c'.repeat(64),
        skills: [
          {
            id: 'a',
            name: 'alpha',
            description: 'Alpha',
            digest: 'd'.repeat(64),
            files: [file('SKILL.md')]
          },
          {
            id: 'b',
            name: 'beta',
            description: 'Beta',
            digest: 'e'.repeat(64),
            files: [file('SKILL.md')]
          }
        ]
      }
    } as unknown as SkillCloudVersion
    expect(checklistItemsFromVersion(bundled).map((item) => item.name)).toEqual(['alpha', 'beta'])
  })
})

describe('checklistItemSummary', () => {
  it('keeps instruction-only and supporting-file summaries simple', () => {
    expect(checklistItemSummary([file('SKILL.md')])).toEqual({
      label: '1 file'
    })
    expect(checklistItemSummary([file('SKILL.md'), file('references/guide.md')])).toEqual({
      label: '2 files'
    })
  })

  it('keeps runnable and binary classifications out of the row summary', () => {
    expect(checklistItemSummary([file('SKILL.md'), file('scripts/setup.sh')])).toEqual({
      label: '2 files'
    })
    expect(checklistItemSummary([file('bin/tool', true)])).toEqual({ label: '1 file' })
    const binary = { ...file('assets/logo.png'), classification: 'binary' as const }
    expect(checklistItemSummary([file('SKILL.md'), binary])).toEqual({
      label: '2 files'
    })
  })
})
