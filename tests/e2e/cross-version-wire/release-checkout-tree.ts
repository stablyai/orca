import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { parse } from 'yaml'
import { createWorkspaceSourceResolver } from '../../../config/scripts/workspace-source-exports.mjs'
import {
  collectPackageImports,
  installMissingPackageStandIns,
  type PackageImports
} from './release-missing-packages.ts'

const CHECKOUT_PROCESS_TIMEOUT_MS = 45_000
const CHECKOUT_MAX_OUTPUT_BYTES = 1024 * 1024

// Extract runtime, renderer, codecs and the phone row reader; omit CLI to bound cold-CI extraction.
// Add source workspace packages from each release’s own policy.
const ARCHIVE_PATHS = [
  'src/main',
  'src/shared',
  'src/preload',
  'src/renderer',
  'src/types',
  'mobile/src/worktree/agent-row-display.ts'
]
// Why optional: a release may have either or both, and `git archive` refuses a missing pathspec.
const OPTIONAL_ARCHIVE_PATHS = [
  'src/relay',
  'src/wsl-guest',
  // Released phone read operations and their runtime decoding dependencies.
  'mobile/src/agent-history/agent-history-reply-schema.ts',
  'mobile/src/agent-history/mobile-agent-history-operations.ts',
  'mobile/src/session/mobile-session-read-operations.ts',
  'mobile/src/session/session-read-reply-schema.ts',
  'mobile/src/transport/mobile-runtime-client-capabilities.ts',
  'mobile/src/transport/request-single-flight.ts',
  'mobile/src/transport/rpc-acceptance-policies.ts',
  'mobile/src/transport/rpc-incompatible-reply-error.ts',
  'mobile/src/transport/rpc-operation-reply.ts',
  'mobile/src/transport/rpc-operation-result-reader.ts',
  'mobile/src/transport/rpc-operation.ts'
]

const WORKSPACE_POLICY = 'pnpm-workspace.yaml'

const ALIAS_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])@(renderer)?\/([^'"]+)\2/g

// Static, side-effect, lazy and CommonJS loads of a bare specifier.
const BARE_SPECIFIER =
  /(\bfrom\s*|^\s*import\s*|(?<![.\w$])import\s*\(\s*|(?<![.\w$])require\s*\(\s*)(['"])([^'"\s./][^'"\s]*)\2/gm

type WorkspaceSourceResolver = ReturnType<typeof createWorkspaceSourceResolver>

// Include package JS too: orca-source exports may target any supported module extension.
function isRewritableSource(name: string): boolean {
  return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)
}

function isTestSource(name: string): boolean {
  return /\.(test|bench|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)
}

/** Keep renderer aliases inside the extracted release rather than the working tree. */
async function rewriteRendererAliases(
  file: string,
  source: string,
  rendererRoot: string
): Promise<string> {
  if (!source.includes("'@/") && !source.includes('"@/') && !source.includes('@renderer/')) {
    return source
  }
  const rewritten = source.replace(
    ALIAS_SPECIFIER,
    (_match, keyword: string, quote: string, _renderer: string | undefined, target: string) =>
      `${keyword}${quote}${relativeSpecifier(file, join(rendererRoot, target))}${quote}`
  )
  if (rewritten !== source) {
    await writeFile(file, rewritten)
  }
  return rewritten
}

function relativeSpecifier(file: string, absolute: string): string {
  const relativePath = relative(dirname(file), absolute).split('\\').join('/')
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

/** Why: the install link and vitest's workspace aliases would otherwise load current packages. */
async function rewriteWorkspaceImports(
  root: string,
  file: string,
  source: string,
  resolver: WorkspaceSourceResolver
): Promise<string> {
  const rewritten = source.replace(
    BARE_SPECIFIER,
    (match, keyword: string, quote: string, specifier: string) => {
      let target: ReturnType<WorkspaceSourceResolver['resolve']>
      try {
        target = resolver.resolve(specifier)
      } catch (error) {
        throw new Error(`${relative(root, file)}: ${String(error)}`)
      }
      // Native packages can't be built from the release, so they keep the current install.
      return target
        ? `${keyword}${quote}${relativeSpecifier(file, join(root, target.file))}${quote}`
        : match
    }
  )
  if (rewritten !== source) {
    await writeFile(file, rewritten)
  }
  return rewritten
}

async function prepareExtractedTree(
  root: string,
  workspacePaths: string[],
  packageImports: PackageImports
): Promise<void> {
  const resolver = workspacePaths.length > 0 ? createWorkspaceSourceResolver(root) : null
  const rendererRoot = join(root, 'src', 'renderer', 'src')
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      // Why: stale specs must not enter repo-wide tool walks through the cache.
      if (isTestSource(entry.name)) {
        await rm(full)
        continue
      }
      if (isRewritableSource(entry.name)) {
        let source = await rewriteRendererAliases(full, await readFile(full, 'utf8'), rendererRoot)
        if (resolver) {
          source = await rewriteWorkspaceImports(root, full, source, resolver)
        }
        collectPackageImports(source, packageImports)
      }
    }
  }
  await walk(join(root, 'src'))
  // Source packages outside src/ load from here too; native ones keep the current install.
  for (const path of workspacePaths) {
    if (path !== WORKSPACE_POLICY && !path.startsWith('src/') && !path.startsWith('native/')) {
      await walk(join(root, path))
    }
  }
}

function checkoutTarProgram(): string {
  if (process.platform !== 'win32') {
    return 'tar'
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'tar.exe')
}

async function runCheckoutProcess(
  repoRoot: string,
  program: string,
  args: string[],
  deadline: number
): Promise<string> {
  // Kept lazy so plain Node 24 contention children never load Vite's TS graph.
  const { runProcess } = await import('@orca/process-host')
  const result = await runProcess({
    program,
    args,
    cwd: repoRoot,
    timeoutMs: Math.max(1, deadline - Date.now()),
    maxOutputBytes: CHECKOUT_MAX_OUTPUT_BYTES,
    terminationBarrier: true
  })
  if (result.code === 0 && !result.timedOut) {
    return result.stdout
  }
  const detail = result.timedOut
    ? `timed out after ${CHECKOUT_PROCESS_TIMEOUT_MS}ms`
    : result.stderr.trim() || `exited with ${result.code}`
  throw new Error(`${program} ${args[0] ?? ''} ${detail}`)
}

function workspacePatternRoot(pattern: string): string {
  const segments: string[] = []
  for (const segment of pattern.replace(/\/$/, '').split('/')) {
    if (/[*?[\]{}!]/.test(segment)) {
      break
    }
    segments.push(segment)
  }
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Unsupported release workspace package pattern: ${pattern}`)
  }
  return segments.join('/')
}

async function listReleasePaths(
  repoRoot: string,
  commit: string,
  paths: string[],
  deadline: number
): Promise<string[]> {
  return (
    await runCheckoutProcess(
      repoRoot,
      'git',
      ['ls-tree', '-z', '--name-only', commit, '--', ...paths],
      deadline
    )
  )
    .split('\0')
    .filter(Boolean)
}

async function releaseWorkspaceArchivePaths(
  repoRoot: string,
  commit: string,
  deadline: number
): Promise<string[]> {
  const listed = (paths: string[]): Promise<string[]> =>
    listReleasePaths(repoRoot, commit, paths, deadline)
  if ((await listed([WORKSPACE_POLICY])).length === 0) {
    return []
  }
  const policy = await runCheckoutProcess(
    repoRoot,
    'git',
    ['cat-file', 'blob', `${commit}:${WORKSPACE_POLICY}`],
    deadline
  )
  const { packages = [] } = parse(policy) ?? {}
  if (!Array.isArray(packages) || packages.some((pattern) => typeof pattern !== 'string')) {
    throw new Error(`Release ${commit} has unreadable workspace package patterns`)
  }
  const roots = [
    ...new Set(
      packages
        .filter((pattern: string) => !pattern.startsWith('!'))
        .map((pattern: string) => workspacePatternRoot(pattern))
    )
  ]
  return [WORKSPACE_POLICY, ...(roots.length > 0 ? await listed(roots) : [])]
}

export async function extractReleaseCheckoutTree(
  repoRoot: string,
  staging: string,
  commit: string,
  sourceOnly = false
): Promise<PackageImports> {
  const archive = join(staging, '.release-checkout.tar')
  const deadline = Date.now() + CHECKOUT_PROCESS_TIMEOUT_MS
  const workspacePaths = await releaseWorkspaceArchivePaths(repoRoot, commit, deadline)
  const optionalPaths = await listReleasePaths(repoRoot, commit, OPTIONAL_ARCHIVE_PATHS, deadline)
  try {
    await runCheckoutProcess(
      repoRoot,
      'git',
      [
        'archive',
        '--format=tar',
        `--output=${archive}`,
        commit,
        '--',
        ...ARCHIVE_PATHS,
        ...optionalPaths,
        ...workspacePaths
      ],
      deadline
    )
    await runCheckoutProcess(
      repoRoot,
      checkoutTarProgram(),
      ['-xf', archive, '-C', staging],
      deadline
    )
  } finally {
    await rm(archive, { force: true })
  }
  const packageImports: PackageImports = new Map()
  await prepareExtractedTree(staging, workspacePaths, packageImports)
  if (!sourceOnly) {
    await installMissingPackageStandIns(
      staging,
      commit,
      packageImports,
      JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    )
  }
  return packageImports
}

export async function scavengeReleaseCheckoutStaging(
  directory: string,
  prefix: string
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      await rm(join(directory, entry.name), { recursive: true, force: true })
    }
  }
}
