import {
  constructGitRemotePolicies,
  parseGitConfigOriginSnapshot,
  type GitLegacyEntryObservation
} from './git-config-snapshot-runner'
import { constants, type Dirent } from 'node:fs'
import { lstat, readdir, realpath, stat, open } from 'node:fs/promises'
import path from 'node:path'
import { isMissingGitAdminEntry, type GitAdminReadOptions } from './git-common-directory'
import { resolveGitMetadataPath } from './git-metadata-path'
import { mapWithConcurrency } from './map-with-concurrency'
import { ADMIN_READ_CONCURRENCY } from './git-worktree-admin-layout'

async function readGitLegacyEntry(
  file: string,
  name: string,
  options: GitAdminReadOptions
): Promise<GitLegacyEntryObservation> {
  options.signal?.throwIfAborted()
  let target: string | undefined
  try {
    const entry = await lstat(file)
    target = entry.isSymbolicLink() ? await realpath(file) : file
    const metadata = await stat(file)
    if (metadata.isDirectory()) {
      return { name, file, target, kind: 'directory' }
    }
    if (!metadata.isFile()) {
      return { name, file, target, kind: 'special' }
    }
    // A racing symlink swap must never turn this read into a blocking FIFO open.
    const flags =
      process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK
    const handle = await open(file, flags)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        return {
          name,
          file,
          target,
          kind: 'unknown',
          error: 'Legacy Git entry changed while opening.'
        }
      }
      const contents = await handle.readFile({ encoding: 'utf8', signal: options.signal })
      return { name, file, target, contents, kind: 'file' }
    } finally {
      await handle.close()
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined
    return {
      name,
      file,
      target,
      kind: isMissingGitAdminEntry(error) ? 'missing' : 'unknown',
      error: code ?? String(error)
    }
  }
}

/** Direct native nicknames only; observations are not mapping or creation authority. */
export async function readGitLegacyDirectory(directory: string, options: GitAdminReadOptions = {}) {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingGitAdminEntry(error)) {
      return []
    }
    throw error
  }
  return mapWithConcurrency(
    entries.filter(
      (entry) =>
        entry.name !== '.' &&
        entry.name !== '..' &&
        !entry.name.includes('/') &&
        (process.platform !== 'win32' || !entry.name.includes('\\'))
    ),
    ADMIN_READ_CONCURRENCY,
    (entry) => readGitLegacyEntry(path.join(directory, entry.name), entry.name, options)
  )
}

export async function readNativeStores(
  run: (args: string[]) => Promise<{ stdout: string }>,
  cwd: string,
  options: GitAdminReadOptions,
  name?: string
) {
  const suffix = name === undefined ? '' : `/${name}`
  const layout = (
    await run(['rev-parse', '--git-path', `remotes${suffix}`, '--git-path', `branches${suffix}`])
  ).stdout
    .trimEnd()
    .split(/\r?\n/)
  if (layout.length !== 2) {
    throw new Error('Incomplete native Git layout.')
  }
  return Promise.all(
    layout.map((value) => {
      const directory = resolveGitMetadataPath(cwd, value, options)
      if (!directory) {
        throw new Error('Unknown native Git layout.')
      }
      return name === undefined
        ? readGitLegacyDirectory(directory, options)
        : readGitLegacyEntry(directory, name, options).then((row) => [row])
    })
  )
}

export async function observeNativeRemoteNames(
  run: (args: string[]) => Promise<{ stdout: string }>,
  built: ReturnType<typeof constructGitRemotePolicies>,
  stores: readonly (readonly GitLegacyEntryObservation[])[],
  urls = new Map<string, string>(),
  pushes = new Map<string, string[]>()
) {
  const special = new Set(
    stores.flatMap((rows) => rows.filter((row) => row.kind === 'special').map((row) => row.name))
  )
  for (const name of new Set([...built.fallback, ...built.observe])) {
    if (special.has(name)) {
      throw new Error(`Cannot establish current native Git policy for ${name}.`)
    }
    try {
      const fetch = (await run(['remote', 'get-url', '--all', '--', name])).stdout
        .trimEnd()
        .split(/\r?\n/)
      const push = (await run(['remote', 'get-url', '--push', '--all', '--', name])).stdout
        .trimEnd()
        .split(/\r?\n/)
      if (built.uncertain.has(name)) {
        throw new Error(`Cannot decode current native Git policy for ${name}.`)
      }
      built.names.add(name)
      if (fetch[0]) {
        urls.set(name, fetch[0])
        pushes.set(name, push.filter(Boolean))
      }
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr.trimEnd()
          : ''
      const diagnostic = stderr.split(/\r?\n/).at(-1)
      if (
        diagnostic !== `error: No such remote '${name}'` &&
        diagnostic !== `fatal: No such remote '${name}'`
      ) {
        throw error
      }
      built.uncertain.delete(name)
    }
  }
  return { urls, pushes }
}

/** Selected read-only policy: caller only, on its owning runner and filesystem. */
export async function readGitRemotePolicy(
  exec: (args: string[], cwd: string) => Promise<{ stdout: string }>,
  cwd: string,
  name: string,
  options: GitAdminReadOptions = {}
) {
  const run = (args: string[]) => exec(args, cwd)
  const { config } = parseGitConfigOriginSnapshot(
    (await run(['config', '--show-origin', '--list', '-z', '--includes'])).stdout
  )
  const nickname =
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    (process.platform !== 'win32' || !name.includes('\\'))
  const stores = nickname ? await readNativeStores(run, cwd, options, name) : [[], []]
  const built = constructGitRemotePolicies(config, stores, name)
  const urls = new Map<string, string>()
  const pushes = new Map<string, string[]>()
  if (config.has(`remote.${name}.url`) || config.has(`remote.${name}.vcs`)) {
    built.fallback.add(name)
  }
  await observeNativeRemoteNames(run, built, stores, urls, pushes)
  return {
    fields: built.policy.get(name) ?? new Map<string, string[]>(),
    url: urls.get(name),
    pushes: pushes.get(name) ?? []
  }
}
