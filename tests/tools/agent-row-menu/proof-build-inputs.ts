import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

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

export const rowMenuModules = [
  'src/renderer/src/components/sidebar/workspace-actions/agent-row-menu/AgentRowMenuItems.tsx',
  'src/renderer/src/components/sidebar/workspace-actions/agent-row-menu/agent-row-menu-target.ts',
  'src/renderer/src/components/tab-bar/session-actions/NativeChatCliForkMenuItems.tsx'
] as const
export const pairedActivationModules = [
  'src/renderer/src/lib/workspace/tabs/terminal-tab-owner-activation.ts',
  'src/renderer/src/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle.ts',
  'src/renderer/src/components/terminal-pane/pty-transport/legacy-relay/legacy-relay-bridge-panes.ts',
  'src/renderer/src/runtime/web-session-tabs-sync/identity/tracking-mappings.ts'
] as const

type MappedSource = {
  blob: string
  sourceSha256: string
  map: string
  mapSha256: string
  sourceEntry: string
  sourceIndex: number
  chunk: string
}

export function recordBuildInputs() {
  const source = assertFrozenSource()
  const modules = [...rowMenuModules, ...pairedActivationModules]
  const frozen = new Map<string, { blob: string; sourceSha256: string }>(
    modules.map((file) => {
      const blob = git('rev-parse', `${source.head}:${file}`)
      const bytes = execFileSync('git', ['cat-file', 'blob', blob])
      const sourceSha256 = sha256(bytes)
      assert.equal(digest(file), sourceSha256, file)
      return [file, { blob, sourceSha256 }]
    })
  )
  const sources: Record<string, MappedSource[]> = {}
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
      const map: { sources: string[]; sourcesContent?: (string | null)[]; sourceRoot?: string } =
        JSON.parse(readFileSync(join(root, path), 'utf8'))
      for (const [sourceIndex, sourceEntry] of map.sources.entries()) {
        const module = relative(
          root,
          resolve(dirname(join(root, path)), map.sourceRoot ?? '', sourceEntry)
        )
          .split(sep)
          .join('/')
        const input = frozen.get(module)
        if (!input) {
          continue
        }
        const content = map.sourcesContent?.[sourceIndex]
        if (typeof content !== 'string' || sha256(content) !== input.sourceSha256) {
          continue
        }
        const mapping = {
          ...input,
          map: path,
          mapSha256: artifacts[path],
          sourceEntry,
          sourceIndex,
          chunk: path.slice(0, -'.map'.length)
        }
        const sourceMappings = (sources[module] ??= [])
        sourceMappings.push(mapping)
      }
    }
  }
  for (const module of modules) {
    assert.ok(sources[module]?.length, `Unverified source content for ${module}`)
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
    sources
  }
}
