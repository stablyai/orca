import { describe, expect, it } from 'vitest'
import { SkillBundleInstallRequestSchema } from './skill-bundle-install-contract'

const digest = 'a'.repeat(64)

function request() {
  return {
    operationId: 'operation_1',
    package: {
      packageId: 'package_1',
      versionId: 'version_1',
      bundleDigest: digest,
      archiveSha256: digest,
      compressedBytes: 1024
    },
    selectedSkillIds: ['alpha', 'beta'],
    ingress: { kind: 'local-file' as const, path: '/tmp/bundle.tar.gz' },
    destination: { scope: 'global' as const },
    conflictDecisions: [{ skillId: 'alpha', resolution: 'keep-local' as const }]
  }
}

describe('skill bundle install contract', () => {
  it('rejects duplicate selections and decisions for unselected skills', () => {
    expect(() =>
      SkillBundleInstallRequestSchema.parse({
        ...request(),
        selectedSkillIds: ['alpha', 'alpha']
      })
    ).toThrow()
    expect(() =>
      SkillBundleInstallRequestSchema.parse({
        ...request(),
        conflictDecisions: [{ skillId: 'gamma', resolution: 'keep-local' }]
      })
    ).toThrow()
  })
})
