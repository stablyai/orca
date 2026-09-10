import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

type RendererManifestEntry = {
  file: string
  imports?: string[]
  dynamicImports?: string[]
}

type RendererManifest = Record<string, RendererManifestEntry>

const E2E_STORE_ASSIGNMENT = /\.__store\s*=/
const E2E_BUILD_COMMAND = 'pnpm exec electron-vite build --mode e2e'

function readRendererManifest(manifestPath: string): RendererManifest {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as RendererManifest
  } catch (error) {
    throw new Error(`Cannot read the current renderer manifest at ${manifestPath}`, {
      cause: error
    })
  }
}

export function assertE2eBuildInstrumentation(root: string): void {
  const outMain = path.join(root, 'out', 'main', 'index.js')
  const rendererRoot = path.join(root, 'out', 'renderer')
  const manifestPath = path.join(rendererRoot, '.vite', 'manifest.json')
  const fail = (reason: string): never => {
    throw new Error(
      `SKIP_BUILD requires current E2E-instrumented output: ${reason}. Run "${E2E_BUILD_COMMAND}" before retrying.`
    )
  }

  if (!existsSync(outMain)) {
    fail(`${outMain} is missing`)
  }
  if (!existsSync(manifestPath)) {
    fail(`${manifestPath} is missing`)
  }

  let manifest: RendererManifest
  try {
    manifest = readRendererManifest(manifestPath)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const pending = ['index.html']
  const visited = new Set<string>()
  while (pending.length > 0) {
    const key = pending.pop()
    if (!key || visited.has(key)) {
      continue
    }
    visited.add(key)

    const entry = manifest[key]
    if (!entry) {
      fail(`manifest entry ${key} is missing`)
    }
    const outputPath = path.resolve(rendererRoot, entry.file)
    if (!outputPath.startsWith(`${path.resolve(rendererRoot)}${path.sep}`)) {
      fail(`manifest entry ${key} resolves outside out/renderer`)
    }
    if (!existsSync(outputPath)) {
      fail(`current manifest output ${entry.file} is missing`)
    }
    if (entry.file.endsWith('.js') && E2E_STORE_ASSIGNMENT.test(readFileSync(outputPath, 'utf8'))) {
      return
    }

    pending.push(...(entry.imports ?? []), ...(entry.dynamicImports ?? []))
  }

  fail('the current renderer entry graph does not expose window.__store')
}
