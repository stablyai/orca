import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
export const root = realpathSync(process.cwd())
export const evidenceDir = resolve(
  process.env.ORCA_ROW_MENU_EVIDENCE_DIR ?? 'test-results/agent-row-menu'
)
export const buildInputsPath = join(evidenceDir, 'build-inputs.json')

export function assertFrozenSource() {
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
  assert.equal(Boolean(process.env.SKIP_BUILD), false)
  const head = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  const base = process.env.ORCA_ROW_MENU_BASE ?? ''
  assert.equal(head, process.env.ORCA_ROW_MENU_HEAD)
  assert.equal(tree, process.env.ORCA_ROW_MENU_TREE)
  assert.match(base, /^[a-f0-9]{40}$/)
  assert.equal(git('merge-base', 'origin/main', head), base)
  assert.equal(git('status', '--porcelain'), '')
  return { head, base, tree }
}

export const sha256 = (content: string | Buffer) =>
  createHash('sha256').update(content).digest('hex')
export const digest = (path: string) => sha256(readFileSync(join(root, path)))

export const rowMenuModules = ['AgentRowMenuItems.tsx', 'agent-row-menu-target.ts'] as const
export const pairedActivationModules = [
  'web-runtime-session-tab-lifecycle.ts',
  'legacy-relay-bridge-panes.ts',
  'tracking-mappings.ts'
] as const
type ProofModule = (typeof rowMenuModules)[number] | (typeof pairedActivationModules)[number]

export function recordBuildInputs() {
  const source = assertFrozenSource()
  const sources = new Map<ProofModule, string[]>()
  const artifacts: Record<string, string> = {}
  for (const target of ['main', 'preload', 'renderer']) {
    const dir = join(root, 'out', target)
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?js|html|css|map)$/.test(entry.name)) {
        continue
      }
      const path = relative(root, join(entry.parentPath, entry.name))
      artifacts[path] = digest(path)
      if (target !== 'renderer' || !path.endsWith('.js.map')) {
        continue
      }
      const map: { sources: string[] } = JSON.parse(readFileSync(join(root, path), 'utf8'))
      for (const module of [...rowMenuModules, ...pairedActivationModules]) {
        if (
          map.sources.some((sourcePath) => sourcePath.replaceAll('\\', '/').endsWith(`/${module}`))
        ) {
          const file = path.slice(0, -'.map'.length)
          sources.set(module, [...(sources.get(module) ?? []), file])
        }
      }
    }
  }
  for (const module of [...rowMenuModules, ...pairedActivationModules]) {
    assert.ok(sources.has(module), `Fresh renderer build did not map ${module}`)
  }
  const driverDir = 'tests/tools/agent-row-menu'
  return {
    ...source,
    node: process.version,
    driverInputs: Object.fromEntries(
      readdirSync(join(root, driverDir))
        .filter((file) => file.endsWith('.ts'))
        .map((file) => [file, digest(join(driverDir, file))])
    ),
    lockfile: digest('pnpm-lock.yaml'),
    artifacts,
    sources: Object.fromEntries(sources)
  }
}
