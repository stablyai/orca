import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isSafeGitRefName } from './git-status-upstream-ref'
import {
  isMissingGitAdminEntry,
  readGitAdminFile,
  resolveGitCommonDirectory,
  type GitAdminReadOptions
} from './git-common-directory'
import { resolveGitMetadataPath, resolveWorktreeHostPath } from './git-metadata-path'
import { mapWithConcurrency } from './map-with-concurrency'
import {
  ADMIN_READ_CONCURRENCY,
  hostPathKey,
  readWorktreeAdminDirectories
} from './git-worktree-admin-layout'

export type GitNativeContext = {
  gitDir: string
  cwd: string
  args: string[]
  head: string
  privateConfig: string | null
}

/** Validate every registration, including administration whose checkout has disappeared. */
export async function readGitNativeContexts(repoPath: string, options: GitAdminReadOptions = {}) {
  const hostRepoPath = resolveWorktreeHostPath(repoPath, options) ?? repoPath
  const directories = await readWorktreeAdminDirectories(hostRepoPath, options, true)
  const commonDir = await realpath(directories[0].gitDir)
  const seen = new Set<string>()
  const worktreeKeys = new Set<string>()
  const contexts = await mapWithConcurrency(
    directories,
    ADMIN_READ_CONCURRENCY,
    async (entry): Promise<GitNativeContext> => {
      const gitDir = await realpath(entry.gitDir)
      const key = hostPathKey(gitDir)
      if (seen.has(key)) {
        throw new Error('Ambiguous Git administration.')
      }
      seen.add(key)
      const head = await readGitAdminFile(path.join(gitDir, 'HEAD'), options.signal)
      if (
        !head ||
        !(head.startsWith('ref: ')
          ? isSafeGitRefName(head.slice(5).trimEnd())
          : /^(?:[0-9a-f]{40}|[0-9a-f]{64})\r?\n?$/i.test(head))
      ) {
        throw new Error('Cannot verify Git administration HEAD.')
      }
      let worktree =
        entry.isMain && path.basename(gitDir) === '.git' ? path.dirname(gitDir) : entry.worktreePath
      if (worktree) {
        const targetKey = hostPathKey(worktree)
        if (worktreeKeys.has(targetKey)) {
          throw new Error('Ambiguous worktree registration.')
        }
        worktreeKeys.add(targetKey)
      }
      if (!entry.isMain) {
        const relative = path.relative(commonDir, gitDir).split(path.sep)
        const pointer = await readGitAdminFile(path.join(gitDir, 'commondir'), options.signal)
        const owner = pointer && resolveGitMetadataPath(gitDir, pointer, options)
        if (
          relative.length !== 2 ||
          relative[0] !== 'worktrees' ||
          !relative[1] ||
          !owner ||
          hostPathKey(await realpath(owner)) !== hostPathKey(commonDir) ||
          !entry.gitFilePath ||
          path.basename(entry.gitFilePath) !== '.git' ||
          !(await lstat(path.join(gitDir, 'gitdir'))).isFile()
        ) {
          throw new Error('Cannot verify linked Git administration.')
        }
        let present = false
        try {
          present = (await lstat(worktree!)).isDirectory()
        } catch (error) {
          if (!isMissingGitAdminEntry(error)) {
            throw error
          }
        }
        if (present) {
          const marker = await readGitAdminFile(entry.gitFilePath, options.signal)
          const match = marker && /^gitdir: (.+)\r?\n?$/.exec(marker)
          const backlink = match && resolveGitMetadataPath(worktree!, match[1], options)
          if (!backlink || hostPathKey(await realpath(backlink)) !== key) {
            throw new Error('Cannot verify worktree backlink.')
          }
        } else {
          worktree = undefined
        }
      }
      const privateConfig = await readGitAdminFile(
        path.join(gitDir, 'config.worktree'),
        options.signal
      )
      return {
        gitDir,
        cwd: worktree ?? gitDir,
        args: worktree ? [] : ['--git-dir=.'],
        head,
        privateConfig
      }
    }
  )
  const callerCommon = await resolveGitCommonDirectory(hostRepoPath, options)
  if (!callerCommon || hostPathKey(await realpath(callerCommon)) !== hostPathKey(commonDir)) {
    throw new Error('Git administration changed.')
  }
  const callerHost = await realpath(resolveWorktreeHostPath(repoPath, options) ?? repoPath)
  let caller = contexts.find((context) => hostPathKey(context.cwd) === hostPathKey(callerHost))
  if (!caller) {
    const marker = await readGitAdminFile(path.join(callerHost, '.git'), options.signal)
    const pointer = marker && /^gitdir: (.+)\r?\n?$/.exec(marker)
    const gitDir = pointer ? resolveGitMetadataPath(callerHost, pointer[1], options) : callerHost
    const key = gitDir && hostPathKey(await realpath(gitDir))
    caller = contexts.find((context) => hostPathKey(context.gitDir) === key)
    if (!caller) {
      throw new Error('Caller is not registered in Git administration.')
    }
    caller.cwd = repoPath
    caller.args = []
  }
  return { commonDir, contexts, caller }
}
