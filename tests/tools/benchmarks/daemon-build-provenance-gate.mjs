/**
 * Build-provenance gate for daemon benchmarks (STA-3515 harness finding #3).
 *
 * A measurement is only attributable to a commit when the artifacts it loads
 * were provably built from that commit. `assertDaemonBuildProvenance` FAILS
 * LOUDLY unless every link in the chain holds:
 *
 *   1. `git status` is clean for daemon-relevant paths, so the working tree IS
 *      `git rev-parse HEAD` for everything measured;
 *   2. sha256(config/patches/node-pty@1.1.0.patch) equals the patch hash in
 *      pnpm-lock.yaml AND the patch hash pnpm baked into the installed
 *      node-pty realpath — pnpm names the install dir after the patch content
 *      hash, so this proves the installed native SOURCE is the checked-out
 *      patch;
 *   3. the installed node-pty resolves inside THIS worktree (a sibling
 *      worktree's symlinked install proves nothing about this HEAD);
 *   4. every compiled node-pty binary is at least as new as the newest native
 *      source file, so a stale binary cannot masquerade as patched;
 *   5. out/orcad/daemon-entry.js is rebuilt by THIS call (build-orcad.mjs runs
 *      here), so the daemon bundle is the checked-out HEAD by construction.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'

export function assertDaemonBuildProvenance(repoRoot) {
  const git = (...cmdArgs) =>
    execFileSync('git', cmdArgs, { cwd: repoRoot, encoding: 'utf8' }).trim()
  const headSha = git('rev-parse', 'HEAD')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')

  const relevant = [
    'src/main',
    'src/shared',
    'config/patches',
    'config/scripts/build-orcad.mjs',
    'pnpm-lock.yaml',
    'package.json'
  ]
  // Why -z and a pathspec rather than parsing paths out of the default format: the
  // default quotes any path with a space or non-ASCII byte (core.quotePath), and a
  // rename prints `old -> new`, so a prefix test on the sliced line misses both — a
  // daemon source moved in, or one with a space in its name, would read as clean.
  // With -z git never quotes, and letting git do the matching removes the parse.
  const dirty = execFileSync('git', ['status', '--porcelain', '-z', '--', ...relevant], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split('\0')
    // -z emits a bare `new\0old\0` pair for R/C, so drop the trailing source path:
    // only the status record has the two-column prefix. This test depends on the
    // pathspec above -- git refuses to pair a rename whose source is outside it and
    // downgrades to `A`, so every bare source record still reaching here starts with
    // a watched prefix and never has a space at index 2. Drop the pathspec and a
    // source like `zz a/f.ts` would be misread as a status record (fail-closed: it
    // adds a spurious dirty entry rather than hiding one).
    .filter((record) => record.length > 3 && record[2] === ' ')
    .map((record) => record.slice(3))
  if (dirty.length > 0) {
    throw new Error(
      `PROVENANCE FAILURE: daemon-relevant paths are dirty; results would not be attributable to HEAD ${headSha}:\n  ${dirty.join('\n  ')}`
    )
  }

  const patchFile = join(repoRoot, 'config', 'patches', 'node-pty@1.1.0.patch')
  const patchSha256 = createHash('sha256').update(readFileSync(patchFile)).digest('hex')
  const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
  const lockHashMatch = /node-pty@1\.1\.0:\s*\n\s*hash: ([0-9a-f]{64})/.exec(lockfile)
  if (!lockHashMatch || lockHashMatch[1] !== patchSha256) {
    throw new Error(
      `PROVENANCE FAILURE: pnpm-lock node-pty patch hash (${lockHashMatch?.[1] ?? 'missing'}) != sha256 of checked-out patch (${patchSha256})`
    )
  }

  const requireFromRoot = createRequire(join(repoRoot, 'package.json'))
  const installedPkgJson = requireFromRoot.resolve('node-pty/package.json')
  const installedRealRoot = realpathSync(resolve(installedPkgJson, '..'))
  if (!installedRealRoot.includes(`patch_hash=${patchSha256}`)) {
    throw new Error(
      `PROVENANCE FAILURE: installed node-pty at ${installedRealRoot} was not built from the checked-out patch (expected patch_hash=${patchSha256}). Run pnpm install.`
    )
  }
  if (!installedRealRoot.startsWith(realpathSync(repoRoot) + sep)) {
    throw new Error(
      `PROVENANCE FAILURE: node_modules/node-pty resolves outside this worktree (${installedRealRoot}); a sibling worktree's install cannot prove this HEAD`
    )
  }

  const releaseDir = join(installedRealRoot, 'build', 'Release')
  const nativeBinaries = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter(
        (name) => name.endsWith('.node') || name === 'spawn-helper' || name.endsWith('.exe')
      )
    : []
  if (nativeBinaries.length === 0) {
    throw new Error(`PROVENANCE FAILURE: no compiled node-pty binaries under ${releaseDir}`)
  }
  const srcDir = join(installedRealRoot, 'src')
  let newestSourceMtime = 0
  for (const entry of readdirSync(srcDir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      newestSourceMtime = Math.max(
        newestSourceMtime,
        statSync(join(entry.parentPath, entry.name)).mtimeMs
      )
    }
  }
  const staleBinaries = nativeBinaries.filter(
    (name) => statSync(join(releaseDir, name)).mtimeMs < newestSourceMtime
  )
  if (staleBinaries.length > 0) {
    throw new Error(
      `PROVENANCE FAILURE: node-pty binaries older than patched sources (stale: ${staleBinaries.join(', ')}). Rebuild node-pty.`
    )
  }

  // Rebuild the daemon bundle from the (clean) working tree = HEAD by construction.
  console.log('[provenance] rebuilding daemon bundle from HEAD…')
  const daemonBundle = join(repoRoot, 'out', 'orcad', 'daemon-entry.js')
  const buildStartedAt = Date.now()
  const build = spawnSync(
    process.execPath,
    [join(repoRoot, 'config', 'scripts', 'build-orcad.mjs')],
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )
  if (build.status !== 0) {
    throw new Error(`PROVENANCE FAILURE: daemon bundle build exited ${build.status}`)
  }
  if (!existsSync(daemonBundle) || statSync(daemonBundle).mtimeMs < buildStartedAt) {
    throw new Error('PROVENANCE FAILURE: daemon bundle missing or not refreshed by this build')
  }

  const provenance = {
    headSha,
    // Parents make a local merge HEAD attributable to its upstream inputs.
    headParents: git('log', '-1', '--format=%P').split(' '),
    branch,
    patchSha256,
    installedNodePtyRealpath: installedRealRoot,
    nativeBinaries,
    daemonBundleBuiltAt: new Date(buildStartedAt).toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch
  }
  console.log(
    `[provenance] OK: HEAD ${headSha} (${branch}), node-pty patch ${patchSha256.slice(0, 12)}…`
  )
  return provenance
}
