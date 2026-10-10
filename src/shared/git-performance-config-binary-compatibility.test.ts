/**
 * Real-binary contract for repository Git tuning: the config reads, conditional
 * unsets, index-path lookup and fsmonitor probe must behave the same on the
 * baseline Git, the first releases past each version floor, and a current one.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { GitCapabilityCache } from './git-capability-cache'
import { readGitIndexEntryCount } from './git-performance-config-filesystem'
import {
  probeFsmonitorDaemon,
  runGitPerformanceConfigAction,
  type GitPerformanceConfigHost
} from './git-performance-config-runner'
import {
  isGitVersionAtLeast,
  parseGitVersion,
  type GitVersion
} from './git-performance-config-plan'

const binary = process.env.ORCA_GIT_COMPAT_BINARY
const image = process.env.ORCA_GIT_COMPAT_IMAGE
const expectedVersion = process.env.ORCA_GIT_COMPAT_VERSION
const dockerUser =
  typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : []
const CONTAINER_REPO = '/repo'
// Why: the Docker lane starts one container per Git command, about 30 of them per apply/revert.
const LANE_TIMEOUT_MS = image ? 300_000 : 30_000

describe.skipIf(!binary && !image)(
  'repository Git tuning real Git compatibility',
  { timeout: LANE_TIMEOUT_MS },
  () => {
    let repoPath = ''
    let version: GitVersion = { major: 0, minor: 0, patch: 0 }
    // The Docker lane runs Linux Git whatever the test host is.
    const platform: NodeJS.Platform = image ? 'linux' : process.platform

    async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
      const result = await runProcess({
        program: image ? 'docker' : (binary ?? 'git'),
        args: image
          ? [
              'run',
              '--rm',
              '--network=none',
              ...dockerUser,
              '-v',
              `${repoPath}:${CONTAINER_REPO}`,
              '-w',
              CONTAINER_REPO,
              image,
              '-c',
              `safe.directory=${CONTAINER_REPO}`,
              ...args
            ]
          : args,
        cwd: repoPath,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_EXEC_PATH: process.env.GIT_EXEC_PATH,
          HOME: repoPath,
          XDG_CONFIG_HOME: repoPath,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C'
        },
        timeoutMs: 30_000
      })
      if (result.code !== 0 || result.signal || result.timedOut) {
        throw Object.assign(new Error(result.stderr || `git exited ${result.code}`), {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr
        })
      }
      return { stdout: result.stdout, stderr: result.stderr }
    }

    function host(capabilities = new GitCapabilityCache()): GitPerformanceConfigHost {
      return {
        platform,
        git,
        capabilities,
        hasReliableDirectoryMtime: async () => true,
        resolveGitPath: (gitPath) => {
          if (image && gitPath.startsWith(`${CONTAINER_REPO}/`)) {
            return join(repoPath, relative(CONTAINER_REPO, gitPath))
          }
          return isAbsolute(gitPath) ? gitPath : join(repoPath, gitPath)
        }
      }
    }

    async function localValue(key: string): Promise<string | null> {
      try {
        return (await git(['config', '--local', '--get', key])).stdout.trim()
      } catch {
        return null
      }
    }

    beforeAll(async () => {
      repoPath = await mkdtemp(join(tmpdir(), 'orca-git-tuning-compat-'))
      const parsed = parseGitVersion((await git(['--version'])).stdout)
      expect(parsed).not.toBeNull()
      version = parsed ?? version
      expect(`${version.major}.${version.minor}.${version.patch}`).toBe(expectedVersion)
      await git(['init', '-q'])
      await git(['config', 'user.email', 'compatibility@example.invalid'])
      await git(['config', 'user.name', 'Compatibility Test'])
      await writeFile(join(repoPath, 'tracked.txt'), 'compatibility\n')
      await git(['add', 'tracked.txt'])
      await git(['commit', '-qm', 'initial'])
    }, LANE_TIMEOUT_MS)

    afterAll(async () => {
      if (repoPath) {
        await rm(repoPath, { recursive: true, force: true })
      }
    })

    it('classifies the fsmonitor daemon probe for this binary', async () => {
      const capabilities = new GitCapabilityCache()
      const daemonBuilt =
        isGitVersionAtLeast(version, 2, 36) &&
        (platform === 'darwin' || platform === 'win32' || isGitVersionAtLeast(version, 2, 55))
      await expect(probeFsmonitorDaemon(host(capabilities))).resolves.toBe(
        daemonBuilt ? 'compatible' : 'unsupported'
      )
      // The cached answer is reused without another probe.
      expect(capabilities.isKnownSupported('fsmonitor-daemon')).toBe(daemonBuilt)
      expect(capabilities.shouldTry('fsmonitor-daemon')).toBe(daemonBuilt)
    })

    it('locates the index through rev-parse and reads its entry count', async () => {
      const counts = await runGitPerformanceConfigAction(host(), 'inspect')
      expect(counts.state.orcaKeys).toEqual([])
      const { stdout } = await git(['rev-parse', '--git-path', 'index'])
      await expect(readGitIndexEntryCount(host().resolveGitPath(stdout.trim()))).resolves.toBe(1)
    })

    it('applies the version-gated plan, records it, and reverts only what it recorded', async () => {
      const applied = await runGitPerformanceConfigAction(host(), 'apply', { fsmonitor: true })
      const action = (key: string) => applied.plan?.find((entry) => entry.key === key)

      expect(action('fetch.writeCommitGraph')).toMatchObject({ action: 'set' })
      expect(action('index.version')).toMatchObject({ action: 'skip', reason: 'small-repository' })
      expect(action('checkout.workers')).toMatchObject(
        isGitVersionAtLeast(version, 2, 32)
          ? { action: 'set' }
          : { action: 'skip', reason: 'git-too-old' }
      )
      expect(await localValue('fetch.writeCommitGraph')).toBe('true')
      expect(await localValue('checkout.workers')).toBe(
        isGitVersionAtLeast(version, 2, 32) ? '0' : null
      )

      await git(['config', '--local', 'core.untrackedCache', 'keep'])
      // A partial revert drops one key and its record entry only.
      const partial = await runGitPerformanceConfigAction(host(), 'revert', {
        keys: ['fetch.writeCommitGraph']
      })
      expect(partial.reverted).toEqual(['fetch.writeCommitGraph'])
      expect(await localValue('fetch.writeCommitGraph')).toBeNull()
      expect(await localValue('core.untrackedCache')).toBe('keep')

      const reverted = await runGitPerformanceConfigAction(host(), 'revert')

      // The user's later edit no longer matches the exact-value pattern, so it stays.
      expect(reverted.reverted).not.toContain('core.untrackedCache')
      expect(await localValue('core.untrackedCache')).toBe('keep')
      expect(await localValue('fetch.writeCommitGraph')).toBeNull()
      expect(await localValue('orca.performanceConfig')).toBeNull()
      expect(reverted.state).toEqual({ orcaKeys: [], userKeys: ['core.untrackedCache'] })
    })
  }
)
