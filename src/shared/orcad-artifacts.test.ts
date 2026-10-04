import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_RIPGREP_PLATFORMS, bundledRipgrepBinaryName } from './bundled-ripgrep'
import { SERVER_TARGETS } from './node-runtime-pin'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_FOREIGN_SQLITE_READER_ENTRY,
  ORCAD_NODE_PTY_JS_ARTIFACTS,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_RIPGREP_ARTIFACTS,
  ORCAD_RIPGREP_LICENSE_ARTIFACTS,
  orcadArtifactFilenames,
  orcadBunRuntimeFilename,
  orcadNodeRuntimeRelativePath,
  orcadTemplateCommonFilenames
} from './orcad-artifacts'

describe('standalone runtime artifacts', () => {
  it.each(SERVER_TARGETS)(
    'ships the foreign SQLite reader worker the %s runtime starts',
    (target) => {
      expect(orcadArtifactFilenames(target)).toContain(ORCAD_FOREIGN_SQLITE_READER_ENTRY)
    }
  )

  it('names a search binary for every SSH host platform', () => {
    const expected = BUNDLED_RIPGREP_PLATFORMS.map(
      (platform) => `ripgrep/${platform}/${bundledRipgrepBinaryName(platform)}`
    )
    expect(ORCAD_RIPGREP_ARTIFACTS).toEqual(expected)
  })

  it.each(SERVER_TARGETS)('ships only the %s search binary in its install identity', (target) => {
    const [platform, arch] = target.split('-')
    const shipped = orcadArtifactFilenames(target).filter((file) =>
      /^ripgrep\/[^/]+\/rg/.test(file)
    )
    expect(shipped).toEqual([
      `ripgrep/${platform}-${arch}/${bundledRipgrepBinaryName(`${platform}-${arch}`)}`
    ])
  })

  it('ships the binary redistribution notices with every install', () => {
    const sourceDir = join(__dirname, '../../resources/licenses/ripgrep')
    expect(ORCAD_RIPGREP_LICENSE_ARTIFACTS.map((path) => path.split('/').at(-1)).sort()).toEqual(
      readdirSync(sourceDir).sort()
    )
    expect(orcadArtifactFilenames('linux-x64-glibc')).toEqual(
      expect.arrayContaining([...ORCAD_RIPGREP_LICENSE_ARTIFACTS])
    )
  })

  it.each(SERVER_TARGETS)('references the %s runtime instead of carrying a Bun one', (target) => {
    const filenames = orcadArtifactFilenames(target)
    expect(filenames).toContain(ORCAD_NODE_RUNTIME_MARKER_FILENAME)
    expect(filenames).toEqual(expect.arrayContaining(ORCAD_NODE_PTY_JS_ARTIFACTS))
    // A Bun-era selector exits 78 on `.build-target` without its Bun runtime (design D7.1 R5).
    expect(filenames).not.toContain(ORCAD_BUILD_TARGET_FILENAME)
    expect(filenames).not.toContain(orcadBunRuntimeFilename(target))
    expect(filenames.some((file) => file.includes('windows-bun-pty'))).toBe(false)
  })

  it('ships node-pty natives per target, with ConPTY and spawn-helper where they run', () => {
    const natives = (target: string): string[] =>
      orcadArtifactFilenames(target)
        .filter((file) => file.startsWith('node_modules/node-pty/build/Release/'))
        .map((file) => file.slice('node_modules/node-pty/build/Release/'.length))
    expect(natives('linux-arm64-musl')).toEqual(['pty.node'])
    expect(natives('darwin-x64')).toEqual(['pty.node', 'spawn-helper'])
    expect(natives('win32-arm64')).toEqual([
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe'
    ])
  })

  it('keeps the runtime executable under its upstream name in the shared store', () => {
    expect(orcadNodeRuntimeRelativePath('linux-x64-glibc', 'a'.repeat(64))).toEqual([
      '..',
      'runtimes',
      `node-${'a'.repeat(64)}`,
      'bin',
      'node'
    ])
    expect(orcadNodeRuntimeRelativePath('win32-x64', 'b'.repeat(64)).at(-1)).toBe('node.exe')
  })

  it('keeps target-specific files out of the shared template set', () => {
    const common = orcadTemplateCommonFilenames()
    for (const target of SERVER_TARGETS) {
      const specific = orcadArtifactFilenames(target).filter((file) => !common.includes(file))
      expect(specific.every((file) => !common.includes(file))).toBe(true)
      expect(common.every((file) => orcadArtifactFilenames(target).includes(file))).toBe(true)
    }
  })
})
