// Explicit ESM TypeScript lets the Node admission runner share this lifecycle
// without module-type reparsing warnings.
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const E2E_RUN_ID_ENV = 'ORCA_E2E_RUN_ID'
export const E2E_TEST_REPO_PATH_ENV = 'ORCA_E2E_TEST_REPO_PATH'
export const E2E_TEST_WORKTREE_PATH_ENV = 'ORCA_E2E_TEST_WORKTREE_PATH'

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const OWNED_RESOURCE_PREFIXES = ['orca-e2e-repo-', 'orca-e2e-worktree-']

export type E2ERunScope = {
  runId: string
  tempDir: string
  repoPathFile: string
  manifestFile: string
}

type E2ERunManifest = {
  version: 1
  runId: string
  tempDir: string
  resources: string[]
}

type ResolveE2ERunScopeOptions = {
  tempDir?: string
  env?: Record<string, string | undefined>
  createRunId?: () => string
}

type CleanupE2ERunScopeOptions = {
  allowMissingManifest?: boolean
}

type PreparedE2ERunResources = {
  scope: E2ERunScope
  testRepoDir: string
  worktreeDir: string
}

function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`${E2E_RUN_ID_ENV} must contain only letters, numbers, underscores, or dashes`)
  }
}

export function ensureE2ERunId(
  env: Record<string, string | undefined> = process.env,
  createRunId: () => string = randomUUID
): string {
  const existingRunId = env[E2E_RUN_ID_ENV]
  if (existingRunId) {
    assertValidRunId(existingRunId)
    return existingRunId
  }

  const runId = createRunId()
  assertValidRunId(runId)
  env[E2E_RUN_ID_ENV] = runId
  return runId
}

export function resolveE2ERunScope(options: ResolveE2ERunScopeOptions = {}): E2ERunScope {
  const env = options.env ?? process.env
  const runId = ensureE2ERunId(env, options.createRunId)
  const tempDir = realpathSync(options.tempDir ?? os.tmpdir())
  const controlPrefix = `orca-e2e-run-${runId}`

  return {
    runId,
    tempDir,
    repoPathFile: path.join(tempDir, `${controlPrefix}-repo-path.txt`),
    manifestFile: path.join(tempDir, `${controlPrefix}-manifest.json`)
  }
}

function normalizeOwnedResourcePath(scope: E2ERunScope, resourcePath: string): string {
  const normalizedPath = existsSync(resourcePath)
    ? realpathSync(resourcePath)
    : path.resolve(resourcePath)
  const relativePath = path.relative(scope.tempDir, normalizedPath)
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to clean path outside the E2E temp directory: ${resourcePath}`)
  }

  const resourceName = path.basename(normalizedPath)
  if (!OWNED_RESOURCE_PREFIXES.some((prefix) => resourceName.startsWith(prefix))) {
    throw new Error(`Refusing to clean unowned E2E resource: ${resourcePath}`)
  }

  return normalizedPath
}

export function writeE2ERunManifest(scope: E2ERunScope, cleanupPaths: string[]): void {
  const manifest: E2ERunManifest = {
    version: 1,
    runId: scope.runId,
    tempDir: scope.tempDir,
    resources: cleanupPaths.map((resourcePath) => normalizeOwnedResourcePath(scope, resourcePath))
  }
  const temporaryManifest = `${scope.manifestFile}.${process.pid}.${randomUUID()}.tmp`

  try {
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    try {
      linkSync(temporaryManifest, scope.manifestFile)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code === 'EEXIST') {
        throw new Error(`E2E run manifest already exists for ${scope.runId}`)
      }
      throw error
    }
  } finally {
    rmSync(temporaryManifest, { force: true })
  }
}

export function prepareE2ERunScope(
  options: ResolveE2ERunScopeOptions = {}
): PreparedE2ERunResources {
  const env = options.env ?? process.env
  const scope = resolveE2ERunScope({ ...options, env })
  const testRepoDir = realpathSync(mkdtempSync(path.join(scope.tempDir, 'orca-e2e-repo-')))
  const worktreeDir = path.join(scope.tempDir, `orca-e2e-worktree-${randomUUID()}`)

  try {
    // Publish both exact paths before Playwright starts. The runner can then
    // reclaim this run even when setup or teardown is interrupted.
    writeE2ERunManifest(scope, [worktreeDir, testRepoDir])
  } catch (error) {
    rmSync(testRepoDir, { recursive: true, force: true })
    throw error
  }

  env[E2E_TEST_REPO_PATH_ENV] = testRepoDir
  env[E2E_TEST_WORKTREE_PATH_ENV] = worktreeDir
  return { scope, testRepoDir, worktreeDir }
}

function readE2ERunManifest(scope: E2ERunScope): E2ERunManifest | null {
  if (!existsSync(scope.manifestFile)) {
    return null
  }

  const parsed = JSON.parse(readFileSync(scope.manifestFile, 'utf8')) as Partial<E2ERunManifest>
  if (parsed.version !== 1 || parsed.runId !== scope.runId || !Array.isArray(parsed.resources)) {
    throw new Error(`Invalid E2E run manifest for ${scope.runId}`)
  }
  if (parsed.tempDir !== scope.tempDir) {
    throw new Error(`E2E run manifest temp directory mismatch for ${scope.runId}`)
  }

  return {
    version: 1,
    runId: scope.runId,
    tempDir: scope.tempDir,
    resources: parsed.resources.map((resourcePath) => {
      if (typeof resourcePath !== 'string') {
        throw new Error(`Invalid cleanup path in E2E run manifest for ${scope.runId}`)
      }
      return normalizeOwnedResourcePath(scope, resourcePath)
    })
  }
}

export function readPreparedE2ERunResources(
  scope: E2ERunScope,
  env: Record<string, string | undefined> = process.env
): Omit<PreparedE2ERunResources, 'scope'> {
  const rawRepoDir = env[E2E_TEST_REPO_PATH_ENV]
  const rawWorktreeDir = env[E2E_TEST_WORKTREE_PATH_ENV]
  if (!rawRepoDir || !rawWorktreeDir) {
    throw new Error('Electron E2E resources must be prepared by the shared heavy-suite runner')
  }

  const testRepoDir = normalizeOwnedResourcePath(scope, rawRepoDir)
  const worktreeDir = normalizeOwnedResourcePath(scope, rawWorktreeDir)
  const manifest = readE2ERunManifest(scope)
  if (!manifest) {
    throw new Error(`Missing prepared E2E run manifest for ${scope.runId}`)
  }
  const expectedResources = new Set([testRepoDir, worktreeDir])
  if (
    manifest.resources.length !== expectedResources.size ||
    manifest.resources.some((resourcePath) => !expectedResources.has(resourcePath))
  ) {
    throw new Error(`Prepared E2E resources do not match the run manifest for ${scope.runId}`)
  }

  return { testRepoDir, worktreeDir }
}

export function cleanupE2ERunScope(
  scope: E2ERunScope,
  options: CleanupE2ERunScopeOptions = {}
): string[] {
  const manifest = readE2ERunManifest(scope)
  if (!manifest) {
    if (!options.allowMissingManifest) {
      throw new Error(`Missing E2E run manifest for ${scope.runId}`)
    }
    rmSync(scope.repoPathFile, { force: true })
    return []
  }

  const cleanupPaths = [...new Set(manifest.resources)].sort(
    (left, right) => right.length - left.length
  )
  for (const resourcePath of cleanupPaths) {
    rmSync(resourcePath, { recursive: true, force: true })
  }
  rmSync(scope.repoPathFile, { force: true })
  rmSync(scope.manifestFile, { force: true })
  return cleanupPaths
}
