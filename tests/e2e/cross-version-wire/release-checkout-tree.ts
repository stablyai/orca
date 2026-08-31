import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const CHECKOUT_PROCESS_TIMEOUT_MS = 45_000
const CHECKOUT_MAX_OUTPUT_BYTES = 1024 * 1024

// Why: the wire endpoints only need the runtime RPC host, the renderer client, and
// the shared codec. Skipping cli/relay keeps a cold CI extraction a few seconds.
const ARCHIVE_PATHS = ['src/main', 'src/shared', 'src/preload', 'src/renderer', 'src/types']

const ALIAS_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])@(renderer)?\/([^'"]+)\2/g

function isRewritableSource(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.tsx')
}

function isTestSource(name: string): boolean {
  return /\.(test|bench|spec)\.(ts|tsx)$/.test(name)
}

/** Keep renderer aliases inside the extracted release rather than the working tree. */
async function rewriteRendererAliases(file: string, rendererRoot: string): Promise<boolean> {
  const source = await readFile(file, 'utf8')
  if (!source.includes("'@/") && !source.includes('"@/') && !source.includes('@renderer/')) {
    return false
  }
  const rewritten = source.replace(
    ALIAS_SPECIFIER,
    (_match, keyword: string, quote: string, _renderer: string | undefined, target: string) => {
      const absolute = join(rendererRoot, target)
      let relativePath = relative(dirname(file), absolute).split('\\').join('/')
      if (!relativePath.startsWith('.')) {
        relativePath = `./${relativePath}`
      }
      return `${keyword}${quote}${relativePath}${quote}`
    }
  )
  if (rewritten === source) {
    return false
  }
  await writeFile(file, rewritten)
  return true
}

async function prepareExtractedTree(root: string): Promise<void> {
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
        await rewriteRendererAliases(full, rendererRoot)
      }
    }
  }
  await walk(join(root, 'src'))
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
): Promise<void> {
  // Kept lazy so plain Node 24 contention children never load Vite's TS graph.
  const { runProcess } = await import('../../../src/shared/child-process/run-process')
  const result = await runProcess({
    program,
    args,
    cwd: repoRoot,
    timeoutMs: Math.max(1, deadline - Date.now()),
    maxOutputBytes: CHECKOUT_MAX_OUTPUT_BYTES,
    terminationBarrier: true
  })
  if (result.code === 0 && !result.timedOut) {
    return
  }
  const detail = result.timedOut
    ? `timed out after ${CHECKOUT_PROCESS_TIMEOUT_MS}ms`
    : result.stderr.trim() || `exited with ${result.code}`
  throw new Error(`${program} ${args[0] ?? ''} ${detail}`)
}

export async function extractReleaseCheckoutTree(
  repoRoot: string,
  staging: string,
  commit: string
): Promise<void> {
  const archive = join(staging, '.release-checkout.tar')
  const deadline = Date.now() + CHECKOUT_PROCESS_TIMEOUT_MS
  try {
    await runCheckoutProcess(
      repoRoot,
      'git',
      ['archive', '--format=tar', `--output=${archive}`, commit, '--', ...ARCHIVE_PATHS],
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
  await prepareExtractedTree(staging)
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
