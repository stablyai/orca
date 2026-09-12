import { describe, expect, it } from 'vitest'
import { pluginCapabilityPathsSchema } from './plugin-capability-scope'
import { PLUGIN_HOST_FILE_API_SPECS } from './plugin-host-file-api'
import { isPluginReadAllowed } from './plugin-read-confinement'

const fileReadSpec = PLUGIN_HOST_FILE_API_SPECS.find((spec) => spec.name === 'files.read')!

describe('plugin read confinement tracer', () => {
  const grant = { paths: pluginCapabilityPathsSchema.parse(['docs/**']) }

  it('matches a schema-validated grant against the canonical target below one root', () => {
    expect(isPluginReadAllowed('/repo', '/repo/docs/readme.md', grant)).toBe(true)
    expect(isPluginReadAllowed('/repo', '/repo/src/index.ts', grant)).toBe(false)
    expect(isPluginReadAllowed('/repo', '/elsewhere/docs/readme.md', grant)).toBe(false)
  })

  it('refuses malformed double-star syntax before authorization', () => {
    expect(pluginCapabilityPathsSchema.safeParse(['docs/**x']).success).toBe(false)
  })

  it('denies unresolved, empty, and malformed grants without throwing', () => {
    expect(isPluginReadAllowed('/repo', '/repo/docs/readme.md', undefined)).toBe(false)
    expect(isPluginReadAllowed('/repo', '/repo/docs/readme.md', { paths: [] })).toBe(false)
    expect(isPluginReadAllowed('/repo', '/repo/docs/readme.md', { paths: ['docs/**x'] })).toBe(
      false
    )
    expect(isPluginReadAllowed('', '/repo/docs/readme.md', grant)).toBe(false)
    expect(isPluginReadAllowed('/repo', '', grant)).toBe(false)
  })

  it('implements literal segments, intra-segment stars, and zero-or-more double stars', () => {
    const paths = pluginCapabilityPathsSchema.parse(['README.*', 'src/*/index.ts', 'docs/**'])
    const expandedGrant = { paths }

    expect(isPluginReadAllowed('/repo', '/repo/README.md', expandedGrant)).toBe(true)
    expect(isPluginReadAllowed('/repo', '/repo/src/app/index.ts', expandedGrant)).toBe(true)
    expect(isPluginReadAllowed('/repo', '/repo/src/app/nested/index.ts', expandedGrant)).toBe(false)
    expect(isPluginReadAllowed('/repo', '/repo/docs', expandedGrant)).toBe(true)
    expect(isPluginReadAllowed('/repo', '/repo/docs/.hidden/file.md', expandedGrant)).toBe(true)
  })
})

describe('plugin read confinement host semantics', () => {
  const canonicalConfinementCases = [
    {
      label: 'in-scope alias canonicalized into another worktree',
      hostileForm: 'docs/link.md -> /repo/other/private.md',
      stage: 'canonical-confinement',
      root: '/repo/app',
      target: '/repo/other/private.md',
      paths: ['docs/**'],
      expected: false
    },
    {
      label: 'out-of-scope alias canonicalized into the granted subtree',
      hostileForm: 'outside/link.md -> /repo/app/docs/readme.md',
      stage: 'canonical-confinement',
      root: '/repo/app',
      target: '/repo/app/docs/readme.md',
      paths: ['docs/**'],
      expected: true
    },
    {
      label: 'sibling-prefix escape',
      hostileForm: '/repo/app -> /repo/application/docs/readme.md',
      stage: 'canonical-confinement',
      root: '/repo/app',
      target: '/repo/application/docs/readme.md',
      paths: ['**'],
      expected: false
    },
    {
      label: 'other POSIX worktree',
      hostileForm: '/repo/app -> /repo/other/docs/readme.md',
      stage: 'canonical-confinement',
      root: '/repo/app',
      target: '/repo/other/docs/readme.md',
      paths: ['**'],
      expected: false
    },
    {
      label: 'other Windows drive',
      hostileForm: 'C: root -> D: target',
      stage: 'canonical-confinement',
      root: 'C:\\Repo',
      target: 'D:\\Repo\\docs\\readme.md',
      paths: ['**'],
      expected: false
    },
    {
      label: 'other UNC share',
      hostileForm: '\\\\server\\share -> \\\\server\\other',
      stage: 'canonical-confinement',
      root: '\\\\server\\share\\repo',
      target: '\\\\server\\other\\repo\\docs\\readme.md',
      paths: ['**'],
      expected: false
    },
    {
      label: 'Windows drive backslash separators',
      hostileForm: 'C:\\Repo\\docs\\secret.txt',
      stage: 'canonical-confinement',
      root: 'C:\\Repo',
      target: 'C:\\Repo\\docs\\secret.txt',
      paths: ['docs/**'],
      expected: true
    },
    {
      label: 'UNC mixed separator and case aliases',
      hostileForm: '\\\\Server\\Share\\Repo -> //server/share/repo/Docs/readme.md',
      stage: 'canonical-confinement',
      root: '\\\\Server\\Share\\Repo',
      target: '//server/share/repo/Docs/readme.md',
      paths: ['docs/**'],
      expected: true
    },
    {
      label: 'WSL UNC alias preserves Linux path case',
      hostileForm: 'wsl$ -> wsl.localhost with path case mismatch',
      stage: 'canonical-confinement',
      root: '\\\\wsl$\\Ubuntu\\home\\Ada\\repo',
      target: '\\\\wsl.localhost\\ubuntu\\home\\Ada\\repo\\Docs\\readme.md',
      paths: ['docs/**'],
      expected: false
    },
    {
      label: 'POSIX backslash remains a filename character',
      hostileForm: '/repo/docs\\secret.txt',
      stage: 'canonical-confinement',
      root: '/repo',
      target: '/repo/docs\\secret.txt',
      paths: ['docs/**'],
      expected: false
    },
    {
      label: 'alternate data stream is not reclassified after canonicalization',
      hostileForm: 'docs/report.txt:secret',
      stage: 'canonical-confinement',
      root: 'C:\\Repo',
      target: 'C:\\Repo\\docs\\report.txt:secret',
      paths: ['docs/**'],
      expected: true
    },
    {
      label: 'reserved device name is decided by the existing grant',
      hostileForm: 'docs/CON.txt',
      stage: 'canonical-confinement',
      root: 'C:\\Repo',
      target: 'C:\\Repo\\docs\\CON.txt',
      paths: ['docs/**'],
      expected: true
    },
    {
      label: 'trailing dot segment is decided by the existing grant',
      hostileForm: 'docs/report.',
      stage: 'canonical-confinement',
      root: 'C:\\Repo',
      target: 'C:\\Repo\\docs\\report.',
      paths: ['docs/**'],
      expected: true
    },
    {
      label: 'trailing space segment is decided by the existing grant',
      hostileForm: 'docs/report ',
      stage: 'canonical-confinement',
      root: 'C:\\Repo',
      target: 'C:\\Repo\\docs\\report ',
      paths: ['docs/**'],
      expected: true
    }
  ] as const

  it.each(canonicalConfinementCases)(
    '$stage: $label [$hostileForm]',
    ({ root, target, paths, expected }) => {
      expect(isPluginReadAllowed(root, target, { paths })).toBe(expected)
    }
  )

  const requestSchemaCases = [
    { label: 'empty path', hostileForm: '', stage: 'request-schema', expected: false },
    {
      label: 'POSIX absolute path',
      hostileForm: '/etc/passwd',
      stage: 'request-schema',
      expected: false
    },
    {
      label: 'Windows drive absolute path',
      hostileForm: 'C:\\private\\file',
      stage: 'request-schema',
      expected: false
    },
    {
      label: 'UNC absolute path',
      hostileForm: '\\\\server\\share\\file',
      stage: 'request-schema',
      expected: false
    },
    {
      label: 'forward-slash traversal',
      hostileForm: 'docs/../secret',
      stage: 'request-schema',
      expected: false
    },
    {
      label: 'backslash traversal',
      hostileForm: 'docs\\..\\secret',
      stage: 'request-schema',
      expected: false
    },
    {
      label: 'embedded traversal',
      hostileForm: '../secret',
      stage: 'request-schema',
      expected: false
    }
  ] as const

  it.each(requestSchemaCases)('$stage: $label [$hostileForm]', ({ hostileForm, expected }) => {
    expect(
      fileReadSpec.params.safeParse({
        workspaceRef: 'id:folder-1',
        relativePath: hostileForm
      }).success
    ).toBe(expected)
  })

  it('keeps case-colliding grants distinct only on sensitive roots', () => {
    const grant = { paths: ['Docs/**', 'docs/**'] }
    expect(isPluginReadAllowed('/repo', '/repo/DOCS/readme.md', grant)).toBe(false)
    expect(isPluginReadAllowed('C:\\Repo', 'c:\\repo\\DOCS\\readme.md', grant)).toBe(true)
  })
})

describe('plugin read mandatory policy', () => {
  const deniedFamilyExamples = [
    { family: '.git/**', relativePath: '.git' },
    { family: '.git/**', relativePath: '.git/config' },
    { family: '.env*', relativePath: '.env' },
    { family: '.env*', relativePath: '.env.local' },
    { family: '.npmrc', relativePath: '.npmrc' },
    { family: '.netrc', relativePath: '.netrc' },
    { family: '.ssh/**', relativePath: '.ssh' },
    { family: '.ssh/**', relativePath: '.ssh/config' },
    { family: '.aws/**', relativePath: '.aws' },
    { family: '.aws/**', relativePath: '.aws/credentials' },
    { family: '*.pem', relativePath: 'certificate.pem' },
    { family: '*.key', relativePath: 'private.key' },
    { family: 'id_rsa*', relativePath: 'id_rsa' },
    { family: 'id_rsa*', relativePath: 'id_rsa.pub' }
  ] as const

  const deniedPolicyCases = deniedFamilyExamples.flatMap(({ family, relativePath }) => [
    {
      label: `${family} root exact-case`,
      relativePath,
      paths: ['**'],
      expected: false
    },
    {
      label: `${family} nested exact-case`,
      relativePath: `nested/${relativePath}`,
      paths: ['**'],
      expected: false
    },
    {
      label: `${family} root case variant`,
      relativePath: relativePath.toUpperCase(),
      paths: ['**'],
      expected: false
    },
    {
      label: `${family} nested case variant`,
      relativePath: `NESTED/${relativePath.toUpperCase()}`,
      paths: ['**'],
      expected: false
    }
  ])

  const allowedPolicyCases = [
    {
      label: 'ordinary root dotfile',
      relativePath: '.editorconfig',
      paths: ['.*'],
      expected: true
    },
    {
      label: 'ordinary nested dotfile',
      relativePath: 'docs/.notes',
      paths: ['docs/**'],
      expected: true
    },
    { label: '.git near-miss', relativePath: '.gitignore', paths: ['**'], expected: true },
    {
      label: '.npmrc near-miss',
      relativePath: '.npmrc.backup',
      paths: ['**'],
      expected: true
    },
    {
      label: '.netrc near-miss',
      relativePath: '.netrc.backup',
      paths: ['**'],
      expected: true
    },
    { label: '.aws near-miss', relativePath: '.awsome', paths: ['**'], expected: true },
    { label: 'id_rsa near-miss', relativePath: 'id_ed25519', paths: ['**'], expected: true }
  ] as const

  it.each([...deniedPolicyCases, ...allowedPolicyCases])(
    '$label: $relativePath -> $expected',
    ({ relativePath, paths, expected }) => {
      expect(isPluginReadAllowed('/repo', `/repo/${relativePath}`, { paths })).toBe(expected)
    }
  )

  it('allows a directory itself through X/** and supports per-child filtering', () => {
    const grant = { paths: ['docs/**'] }
    expect(isPluginReadAllowed('/repo', '/repo/docs', grant)).toBe(true)
    expect(isPluginReadAllowed('/repo', '/repo', { paths: ['**'] })).toBe(true)

    const children = ['guide.md', '.notes', '.env', 'nested/index.md']
    expect(
      children.filter((child) => isPluginReadAllowed('/repo', `/repo/docs/${child}`, grant))
    ).toEqual(['guide.md', '.notes', 'nested/index.md'])
  })
})
