import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import { translate } from '@/i18n/i18n'

const DIGEST = 'a'.repeat(64)

function file(
  path: string,
  options: { classification?: 'text' | 'binary'; executable?: boolean; size?: number } = {}
) {
  return {
    path,
    size: options.size ?? 1024,
    executable: options.executable ?? false,
    classification: options.classification ?? ('text' as const),
    sha256: DIGEST,
    identitySha256: DIGEST
  }
}

export function skillWarningPreviewVersion(): SkillCloudVersion {
  const bundleDescription = translate(
    'auto.components.skills.skillWarningPreview.bundleDescription',
    'A preview bundle covering every warning level.'
  )
  const skill = (
    id: string,
    name: string,
    description: string,
    files: ReturnType<typeof file>[]
  ) => ({ id, name, description, digest: DIGEST, files })

  return {
    packageId: 'pkg_warning_preview',
    versionId: 'ver_warning_preview',
    name: 'team-skill-starter-kit',
    description: bundleDescription,
    packageDigest: DIGEST,
    archiveSha256: DIGEST,
    compressedBytes: 48_000,
    createdAt: '2026-08-16T00:00:00.000Z',
    releaseNotes: '',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_warning_preview',
      versionId: 'ver_warning_preview',
      bundleName: 'team-skill-starter-kit',
      description: bundleDescription,
      createdAt: '2026-08-16T00:00:00.000Z',
      skills: [
        skill(
          'instructions-only',
          'writing-guidelines',
          translate(
            'auto.components.skills.skillWarningPreview.instructionsOnlyDescription',
            'Instructions contained entirely in SKILL.md.'
          ),
          [file('SKILL.md')]
        ),
        skill(
          'supporting-files',
          'design-references',
          translate(
            'auto.components.skills.skillWarningPreview.supportingFilesDescription',
            'Includes readable reference files beyond the main instructions.'
          ),
          [file('SKILL.md'), file('references/checklist.md'), file('references/examples.json')]
        ),
        skill(
          'runnable-files',
          'release-automation',
          translate(
            'auto.components.skills.skillWarningPreview.runnableFilesDescription',
            'Includes scripts that an agent may run with your access.'
          ),
          [file('SKILL.md'), file('release.py'), file('scripts/setup.sh', { executable: true })]
        ),
        skill(
          'binary-files',
          'asset-toolkit',
          translate(
            'auto.components.skills.skillWarningPreview.binaryFilesDescription',
            'Includes opaque assets and an executable binary.'
          ),
          [
            file('SKILL.md'),
            file('assets/logo.png', { classification: 'binary', size: 18_400 }),
            file('bin/asset-tool', {
              classification: 'binary',
              executable: true,
              size: 27_000
            })
          ]
        )
      ],
      bundleDigest: DIGEST
    }
  }
}
