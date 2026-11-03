import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as currentProcessHost from '@orca/process-host'
import { importReleaseCheckoutModule } from './release-checkout'
import { extractReleaseCheckoutTree } from './release-checkout-tree'
import { LOCAL_RELEASE_GIT_ENV, prepareReleaseSnapshotSource } from './release-snapshot-source'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  // Why realpath: vite reports module urls through macOS's /var -> /private/var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporaryRoots.push(root)
  return root
}

// Every fixed archive path must exist in a release, or `git archive` refuses the pathspec.
const RELEASE_SKELETON: Record<string, string> = Object.fromEntries(
  [
    'src/main/placeholder.ts',
    'src/shared/placeholder.ts',
    'src/preload/placeholder.ts',
    'src/renderer/src/placeholder.ts',
    'src/types/placeholder.ts',
    'mobile/src/worktree/agent-row-display.ts'
  ].map((path) => [path, 'export {}\n'])
)

function commitRelease(files: Record<string, string>): { repo: string; commit: string } {
  const repo = temporaryDirectory('orca-cross-version-release-repo-')
  for (const [path, source] of Object.entries({ ...RELEASE_SKELETON, ...files })) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), source)
  }
  const git = (args: string[]): string =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: repo,
      encoding: 'utf8'
    }).trim()
  git(['init', '--quiet'])
  git(['add', '--all'])
  git([
    '-c',
    'user.name=release',
    '-c',
    'user.email=release@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--message',
    'release'
  ])
  writeFileSync(join(repo, 'package.json'), '{ "dependencies": {} }\n')
  return { repo, commit: git(['rev-parse', 'HEAD']) }
}

function partialClone(repo: string): string {
  execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: repo })
  execFileSync('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: repo })
  const clone = join(temporaryDirectory('orca-cross-version-partial-'), 'clone')
  execFileSync('git', [
    'clone',
    '--quiet',
    '--filter=blob:none',
    '--no-checkout',
    pathToFileURL(repo).href,
    clone
  ])
  writeFileSync(join(clone, 'package.json'), '{ "dependencies": {} }\n')
  return clone
}

function missingSnapshotObjects(repo: string, commit: string): string[] {
  return execFileSync(
    'git',
    ['rev-list', '--objects', '--no-object-names', '--missing=print', `${commit}^{tree}`],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, ...LOCAL_RELEASE_GIT_ENV } }
  )
    .split('\n')
    .filter((line) => line.startsWith('?'))
}

describe('historical snapshot acquisition', () => {
  it('prepares genuinely missing blobs before metadata, archive and direct-file consumption', async () => {
    const { repo, commit } = commitRelease({
      'pnpm-workspace.yaml': 'packages: []\n',
      'src/main/released.ts': 'export const released = 42\n'
    })
    const clone = partialClone(repo)
    expect(missingSnapshotObjects(clone, commit).length).toBeGreaterThan(0)
    await prepareReleaseSnapshotSource(clone, commit)
    expect(missingSnapshotObjects(clone, commit)).toEqual([])
    execFileSync('git', ['remote', 'set-url', 'origin', join(repo, 'unavailable')], { cwd: clone })
    const staging = temporaryDirectory('orca-cross-version-prepared-')
    await extractReleaseCheckoutTree(clone, staging, commit)
    expect(readFileSync(join(staging, 'src/main/released.ts'), 'utf8')).toContain('released = 42')
    expect(
      execFileSync('git', ['show', `${commit}:src/main/released.ts`], {
        cwd: clone,
        encoding: 'utf8',
        env: { ...process.env, ...LOCAL_RELEASE_GIT_ENV }
      })
    ).toContain('released = 42')
  })

  it('fails before extraction when requested source is unavailable', async () => {
    const { repo, commit } = commitRelease({})
    const clone = partialClone(repo)
    execFileSync('git', ['remote', 'set-url', 'origin', join(repo, 'unavailable')], { cwd: clone })
    const staging = temporaryDirectory('orca-cross-version-unavailable-')
    await expect(extractReleaseCheckoutTree(clone, staging, commit)).rejects.toThrow(
      'Historical source preparation failed'
    )
    expect(existsSync(join(staging, '.release-checkout.tar'))).toBe(false)
    expect(missingSnapshotObjects(clone, commit).length).toBeGreaterThan(0)
  })

  it('terminates a stalled acquisition at its finite preparation deadline', async () => {
    const { repo, commit } = commitRelease({})
    const clone = partialClone(repo)
    const pidFile = join(repo, 'upload-pack.pid')
    const uploadPack = join(repo, 'slow-upload-pack.cjs')
    writeFileSync(
      uploadPack,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)\n`
    )
    execFileSync(
      'git',
      [
        'config',
        'remote.origin.uploadpack',
        `${JSON.stringify(process.execPath)} ${JSON.stringify(uploadPack)}`
      ],
      { cwd: clone }
    )
    await expect(prepareReleaseSnapshotSource(clone, commit, { timeoutMs: 2_000 })).rejects.toThrow(
      'Historical source preparation timed out after 2000ms'
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(missingSnapshotObjects(clone, commit).length).toBeGreaterThan(0)
  })
})

const RELEASE_PROCESS_HOST = {
  'src/packages/process-host/package.json': JSON.stringify({
    name: '@orca/process-host',
    type: 'commonjs',
    exports: {
      '.': { 'orca-source': './src/run-process.ts', default: './dist/run-process.js' },
      './process-spec': {
        'orca-source': './src/process-spec.ts',
        default: './dist/process-spec.js'
      }
    }
  }),
  'src/packages/process-host/src/run-process.ts': [
    "import { describeSpec } from './process-spec'",
    "export const runProcess = () => 'release runProcess'",
    'export const releaseOnlyExport = describeSpec',
    ''
  ].join('\n'),
  'src/packages/process-host/src/process-spec.ts':
    "export const describeSpec = () => 'release process-spec'\n",
  'src/packages/process-host/src/run-process.test.ts': 'throw new Error("stale spec")\n',
  'src/packages/release-tool/package.json': JSON.stringify({
    name: '@orca/release-tool',
    type: 'module',
    exports: {
      '.': { 'orca-source': './src/index.mjs', default: './dist/index.js' },
      './private': { default: './dist/private.js' }
    }
  }),
  'src/packages/release-tool/src/index.mjs':
    "import { runProcess } from '@orca/process-host'\nexport const tool = () => `tool:${runProcess()}`\n",
  'src/packages/release-tool/src/index.test.mjs': 'throw new Error("stale spec")\n'
}

describe('release checkout workspace packages', () => {
  it('loads the release workspace package rather than the current one', async () => {
    expect('releaseOnlyExport' in currentProcessHost).toBe(false)
    const { repo, commit } = commitRelease({
      'pnpm-workspace.yaml': "packages:\n  - src/packages/*\n  - '!src/packages/ignored'\n",
      ...RELEASE_PROCESS_HOST,
      'src/main/consumer.ts': [
        "import { runProcess, releaseOnlyExport } from '@orca/process-host'",
        "import * as spec from '@orca/process-host/process-spec'",
        'export { describeSpec as reexported } from "@orca/process-host/process-spec"',
        'export const staticRun = runProcess()',
        'export const releaseOnly = releaseOnlyExport()',
        'export const specValue = spec.describeSpec()',
        "export const lazyRun = async () => (await import('@orca/process-host')).runProcess()",
        ''
      ].join('\n'),
      'src/main/esm-consumer.mjs': [
        "import { describeSpec } from '@orca/process-host/process-spec'",
        "import { tool } from '@orca/release-tool'",
        'export const esm = `${describeSpec()}|${tool()}`',
        ''
      ].join('\n'),
      'src/main/commonjs-consumer.cjs':
        "module.exports = () => require('@orca/process-host/process-spec')\n",
      'src/renderer/src/lib/view.ts': [
        "import { label } from '@/lib/label'",
        "export const view = async () => `${label}:${(await import('@orca/process-host')).runProcess()}`",
        ''
      ].join('\n'),
      'src/renderer/src/lib/label.ts': "export const label = 'renderer'\n"
    })
    const staging = temporaryDirectory('orca-cross-version-release-staging-')

    await extractReleaseCheckoutTree(repo, staging, commit)
    const checkout = { ref: 'v0.0.0-synthetic', commit, label: 'v0.0.0-synthetic', root: staging }
    const consumer = await importReleaseCheckoutModule(checkout, '/src/main/consumer.ts')
    const view = await importReleaseCheckoutModule(checkout, '/src/renderer/src/lib/view.ts')
    const esm = await importReleaseCheckoutModule(checkout, '/src/main/esm-consumer.mjs')
    const call = async (module: Record<string, unknown>, name: string): Promise<unknown> => {
      const exported = module[name]
      if (typeof exported !== 'function') {
        throw new Error(`synthetic release has no ${name} export`)
      }
      return exported()
    }

    expect(consumer.staticRun).toBe('release runProcess')
    expect(consumer.releaseOnly).toBe('release process-spec')
    expect(consumer.specValue).toBe('release process-spec')
    expect(await call(consumer, 'reexported')).toBe('release process-spec')
    expect(await call(consumer, 'lazyRun')).toBe('release runProcess')
    expect(await call(view, 'view')).toBe('renderer:release runProcess')
    expect(esm.esm).toBe('release process-spec|tool:release runProcess')
    expect(readFileSync(join(staging, 'src/main/commonjs-consumer.cjs'), 'utf8')).toContain(
      "require('../packages/process-host/src/process-spec.ts')"
    )
    expect(existsSync(join(staging, 'src/packages/process-host/src/run-process.test.ts'))).toBe(
      false
    )
    expect(existsSync(join(staging, 'src/packages/release-tool/src/index.test.mjs'))).toBe(false)
    expect(existsSync(join(staging, 'node_modules'))).toBe(false)
  })

  it.each(['@orca/process-host/internal', '@orca/release-tool/private', '@orca/not-in-release'])(
    'fails extraction rather than loading the current tree for %s',
    async (specifier) => {
      const { repo, commit } = commitRelease({
        'pnpm-workspace.yaml': 'packages:\n  - src/packages/*\n',
        ...RELEASE_PROCESS_HOST,
        'src/main/private.ts': `import { x } from '${specifier}'\nexport { x }\n`
      })
      const staging = temporaryDirectory('orca-cross-version-release-staging-')

      const failure = await extractReleaseCheckoutTree(repo, staging, commit).then(
        () => null,
        (error: unknown) => String(error)
      )

      expect(failure).toMatch(/src[/\\]main[/\\]private\.ts: /)
      expect(failure).toContain(`No public orca-source export for ${specifier}`)
    }
  )
})
