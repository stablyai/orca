import { describe, expect, it } from 'vitest'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest,
  validateSkillPackagePath,
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
  it('parses a canonical manifest', () => {
    expect(parseSkillPackageManifest(manifest()).name).toBe('test-skill')
  })

  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9'])(
    'rejects the Windows device skill name %s',
    (name) => {
      expect(() => parseSkillPackageManifest({ ...(manifest() as object), name })).toThrow(
        'skill-package-skill-name-invalid'
      )
    }
  )

  it.each([
    '../SKILL.md',
    '/SKILL.md',
    'C:/SKILL.md',
    'references\\escape.md',
    'references//x.md',
    'references/con',
    'references/trailing. '
  ])('rejects the non-portable path %s', (path) => {
    expect(() => validateSkillPackagePath(path)).toThrow('skill-package-path-invalid')
  })

  it('rejects case collisions and digest drift', () => {
    const collision = [file, { ...file, path: 'skill.md' }]
    expect(() => parseSkillPackageManifest(manifest(collision))).toThrow(
      'skill-package-case-collision'
    )
    expect(() =>
      parseSkillPackageManifest({ ...(manifest() as object), packageDigest: 'c'.repeat(64) })
    ).toThrow('skill-package-digest-mismatch')
  })

  it('requires one identity-matched SKILL.md in canonical path order', () => {
    expect(() => parseSkillPackageManifest(manifest([packageFile('README.md')]))).toThrow(
      'skill-package-skill-markdown-required'
    )
    expect(() => parseSkillPackageManifest(manifest([file, { ...file }]))).toThrow(
      'skill-package-manifest-path-order'
    )
    expect(() =>
      parseSkillPackageManifest({ ...(manifest() as object), schemaVersion: 2 })
    ).toThrow('skill-package-manifest-invalid')
  })

  it('enforces path depth at, below, and above the V1 limit', () => {
    const path = (depth: number): string =>
      [...Array.from({ length: depth - 1 }, (_, index) => `d${index}`), 'SKILL.md'].join('/')
    expect(() => validateSkillPackagePath(path(15))).not.toThrow()
    expect(() => validateSkillPackagePath(path(16))).not.toThrow()
    expect(() => validateSkillPackagePath(path(17))).toThrow('skill-package-path-invalid')
  })

  it('enforces file count at, below, and above the V1 limit', () => {
    const files = (count: number): SkillPackageFile[] => [
      file,
      ...Array.from({ length: count - 1 }, (_, index) =>
        packageFile(`file-${index.toString().padStart(3, '0')}.md`)
      )
    ]
    expect(() => parseSkillPackageManifest(manifest(files(511)))).not.toThrow()
    expect(() => parseSkillPackageManifest(manifest(files(512)))).not.toThrow()
    expect(() => parseSkillPackageManifest(manifest(files(513)))).toThrow(
      'skill-package-manifest-invalid'
    )
  })

  it('enforces per-file and total extracted bytes around both V1 limits', () => {
    const fourMiB = 4 * 1024 * 1024
    expect(() =>
      parseSkillPackageManifest(manifest([{ ...file, size: fourMiB - 1 }]))
    ).not.toThrow()
    expect(() => parseSkillPackageManifest(manifest([{ ...file, size: fourMiB }]))).not.toThrow()
    expect(() => parseSkillPackageManifest(manifest([{ ...file, size: fourMiB + 1 }]))).toThrow(
      'skill-package-manifest-invalid'
    )
    const total = (lastSize: number): SkillPackageFile[] => [
      { ...file, size: 0 },
      ...Array.from({ length: 7 }, (_, index) => packageFile(`payload-${index}.bin`, fourMiB)),
      packageFile('payload-7.bin', lastSize)
    ]
    expect(() => parseSkillPackageManifest(manifest(total(fourMiB - 1)))).not.toThrow()
    expect(() => parseSkillPackageManifest(manifest(total(fourMiB)))).not.toThrow()
    expect(() =>
      parseSkillPackageManifest(manifest([...total(fourMiB), packageFile('z-extra.bin', 1)]))
    ).toThrow('skill-package-total-size-limit')
  })

  it('rejects Unicode normalization and case-fold collisions', () => {
    expect(() => validateSkillPackagePath('references/e\u0301.md')).toThrow(
      'skill-package-path-invalid'
    )
    expect(() =>
      parseSkillPackageManifest(
        manifest([file, packageFile('references/É.md'), packageFile('references/é.md')])
      )
    ).toThrow('skill-package-case-collision')
  })

  it('fuzzes path normalization without accepting traversal or platform syntax', () => {
    let state = 0x5eed
    const random = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state
    }
    const hazards = ['..', '.', '', 'C:', '\\server', 'nul', 'x.', 'x ', 'x\u0000y']
    for (let index = 0; index < 1_000; index += 1) {
      const hazard = hazards[random() % hazards.length]
      const path = `safe/${hazard}/file-${random()}.md`
      expect(() => validateSkillPackagePath(path)).toThrow('skill-package-path-invalid')
    }
  })
})
