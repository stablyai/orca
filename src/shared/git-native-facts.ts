import {
  constructGitRemotePolicies,
  parseGitConfigListSnapshot,
  parseGitConfigOriginSnapshot
} from './git-config-snapshot-runner'
import {
  parseGitRemoteFetchUrls,
  parseGitRemotePushUrls,
  parseGitRemoteNames
} from './git-remote-url-index'
import type { GitRefFact } from './git-branch-cleanup-fetch'
import path from 'node:path'
import { resolveGitMetadataPath } from './git-metadata-path'
import { mapWithConcurrency } from './map-with-concurrency'
import { readGitNativeContexts } from './git-native-contexts'
import { readNativeStores, observeNativeRemoteNames } from './git-native-remote-stores'

const NATIVE_REF_FORMAT =
  '%(refname)%09%(objectname)%09%(symref)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(HEAD)'
function parseNativeRefs(stdout: string): GitRefFact[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [ref, oid, symref, upstream, remote, source, head] = line.split('\t')
      if (!ref || !oid || symref === undefined) {
        throw new Error('Incomplete native Git ref output.')
      }
      return { ref, oid, symref, upstream, remote, source, head }
    })
}

/** Complete invocation-local native facts, shared by action and independent lifetime owners. */
export async function acquireGitNativeFacts(
  exec: (args: string[], cwd: string) => Promise<{ stdout: string }>,
  cwd: string,
  scope = '',
  literal?: string
) {
  const options = { wslDistro: scope || undefined }
  const administration = await readGitNativeContexts(cwd, options)
  const shared = parseNativeRefs(
    (await exec(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)'], cwd)).stdout
  )
  const branches = new Set(
    shared.filter((row) => row.ref.startsWith('refs/heads/')).map((row) => row.ref)
  )
  const common = parseGitConfigOriginSnapshot(
    (
      await exec(
        [
          '--git-dir=.',
          'config',
          '--file',
          'config',
          '--no-includes',
          '--show-origin',
          '--list',
          '-z'
        ],
        administration.commonDir
      )
    ).stdout
  )
  const acquired = await mapWithConcurrency(administration.contexts, 4, async (context) => {
    const run = (args: string[]) => exec([...context.args, ...args], context.cwd)
    const effective = parseGitConfigOriginSnapshot(
      (await run(['config', '--show-origin', '--list', '-z', '--includes'])).stdout
    )
    const raw =
      context.privateConfig === null
        ? new Map<string, string[]>()
        : parseGitConfigListSnapshot(
            (
              await exec(
                [
                  '--git-dir=.',
                  'config',
                  '--file',
                  'config.worktree',
                  '--no-includes',
                  '--list',
                  '-z'
                ],
                context.gitDir
              )
            ).stdout
          )
    const stores = await readNativeStores(run, context.cwd, options)
    const built = constructGitRemotePolicies(effective.config, stores)
    const { policy, names, legacy, fallback } = built
    const endpoints = await observeNativeRemoteNames(run, built, stores)
    return {
      ...context,
      config: effective.config,
      raw,
      origins: effective.origins,
      booleans: effective.booleans,
      stores,
      policy,
      names,
      legacy,
      fallback,
      built,
      endpoints
    }
  })
  const occupiedNames = new Set(acquired.flatMap((context) => [...context.names]))
  const contexts = await mapWithConcurrency(acquired, 4, async (context) => {
    const run = (args: string[]) => exec([...context.args, ...args], context.cwd)
    const { raw, stores, policy, names, legacy } = context
    const effective = {
      config: context.config,
      origins: context.origins,
      booleans: context.booleans
    }
    let probe = 'orca-fork-url-probe'
    while (occupiedNames.has(probe)) {
      probe += '-'
    }
    const caller = context.gitDir === administration.caller.gitDir
    const table = (
      await run([
        ...(caller && literal ? ['-c', `remote.${probe}.url=${literal}`] : []),
        'remote',
        '-v'
      ])
    ).stdout
    const urls = parseGitRemoteFetchUrls(table)
    const pushes = parseGitRemotePushUrls(table)
    for (const name of parseGitRemoteNames(table)) {
      names.add(name)
    }
    const intended =
      caller && literal ? { url: urls.get(probe), pushes: pushes.get(probe) ?? [] } : undefined
    if (intended) {
      urls.delete(probe)
      pushes.delete(probe)
      names.delete(probe)
      if (!intended.url || !intended.pushes.length) {
        throw new Error('Could not resolve fork URL.')
      }
    }
    for (const [name, url] of context.endpoints.urls) {
      urls.set(name, url)
      pushes.set(name, context.endpoints.pushes.get(name) ?? [])
    }
    const relevant = new Set<string>()
    const head = /^ref: (refs\/heads\/[^\r\n]+)/.exec(context.head)?.[1]
    if (head && branches.has(head)) {
      relevant.add(head)
    }
    for (const config of [effective.config, raw]) {
      for (const key of config.keys()) {
        const branch = /^branch\.(.+)\.[^.]+$/.exec(key)?.[1]
        if (branch && branches.has(`refs/heads/${branch}`)) {
          relevant.add(`refs/heads/${branch}`)
        }
      }
    }
    const atoms: GitRefFact[] = []
    let chunk: string[] = []
    let bytes = 0
    const read = async () => {
      if (chunk.length) {
        const requested = new Set(chunk)
        atoms.push(
          ...parseNativeRefs(
            (await run(['for-each-ref', `--format=${NATIVE_REF_FORMAT}`, ...chunk])).stdout
          ).filter((row) => requested.has(row.ref))
        )
        chunk = []
        bytes = 0
      }
    }
    for (const ref of relevant) {
      if (bytes + ref.length > 16000) {
        await read()
      }
      chunk.push(ref)
      bytes += ref.length + 1
    }
    await read()
    const originPath = (origin: string) =>
      origin.startsWith('file:')
        ? resolveGitMetadataPath(context.cwd, origin.slice(5), options)
        : null
    const loaded = new Set(effective.origins.map((row) => originPath(row.origin)))
    const lifetimeUncertain =
      effective.origins.some((row) => {
        if (!/^includeif\..+\.path$/.test(row.key)) {
          return false
        }
        const origin = originPath(row.origin)
        const file =
          row.value &&
          resolveGitMetadataPath(origin ? path.dirname(origin) : context.cwd, row.value, options)
        return !file || !loaded.has(file)
      }) ||
      (!effective.booleans.get('extensions.worktreeconfig') &&
        [...raw.keys()].some((key) => /^include(?:if\..+)?\.path$/.test(key)))
    return {
      ...context,
      config: effective.config,
      raw,
      origins: effective.origins,
      stores,
      policy,
      names,
      legacy,
      urls,
      pushes,
      intended,
      atoms,
      lifetimeUncertain,
      table
    }
  })
  const verified = await readGitNativeContexts(cwd, options)
  if (JSON.stringify(administration) !== JSON.stringify(verified)) {
    throw new Error('Git administration changed during acquisition.')
  }
  const caller = contexts[administration.contexts.indexOf(administration.caller)]
  if (!caller) {
    throw new Error('Missing native caller context.')
  }
  const names = new Set(contexts.flatMap((context) => [...context.names]))
  const mappings = contexts.flatMap((context) =>
    [...context.policy].flatMap(([name, fields]) =>
      (fields.get('fetch') ?? []).map((spec) => ({ name, spec, url: context.urls.get(name) ?? '' }))
    )
  )
  const dependencyConfigs = [
    common.config,
    ...contexts.flatMap((context) => [context.config, context.raw])
  ]
  return {
    ...caller,
    contexts,
    names,
    mappings,
    refs: shared,
    native: contexts.flatMap((context) => context.atoms),
    local: common.config,
    localBooleans: common.booleans,
    dependencyConfigs,
    lifetimeUncertain: contexts.some((context) => context.lifetimeUncertain),
    fingerprint: JSON.stringify([
      administration.commonDir,
      shared,
      common.origins,
      contexts.map((context) => [
        context.gitDir,
        context.cwd,
        context.args,
        context.head,
        context.privateConfig,
        context.origins,
        context.stores,
        context.table,
        context.atoms
      ])
    ])
  }
}
