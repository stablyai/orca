import { describe, expect, it } from 'vitest'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest,
  type SkillPackageFile
} from './skill-package-manifest'

const file: SkillPackageFile = {
  path: 'SKILL.md',
  size: 5,
  executable: false,
  classification: 'text',
  sha256: 'a'.repeat(64),
  identitySha256: 'b'.repeat(64)
}

function manifest(files: SkillPackageFile[] = [file]): unknown {
  return {
    schemaVersion: 1,
    packageId: 'package_1',
    versionId: 'version_1',
    name: 'test-skill',
    description: 'Test',
    createdAt: '2026-08-11T12:00:00.000Z',
    files,
    packageDigest: computeSkillPackageDigest(files)
  }
}

function packageFile(path: string, size = 0): SkillPackageFile {
  return { ...file, path, size }
}

describe('skill package manifest', () => {
  it('rejects case-colliding file paths', () => {
    const collision = [file, { ...file, path: 'skill.md' }]
    expect(() => parseSkillPackageManifest(manifest(collision))).toThrow(
      'skill-package-case-collision'
    )
  })

  it('requires a canonical SKILL.md file', () => {
    expect(() => parseSkillPackageManifest(manifest([packageFile('README.md')]))).toThrow(
      'skill-package-skill-markdown-required'
    )
  })
})
