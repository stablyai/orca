import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertE2eBuildInstrumentation } from './e2e-build-instrumentation'

const roots: string[] = []

function createOutput(storeSource: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-build-instrumentation-'))
  roots.push(root)
  mkdirSync(path.join(root, 'out', 'main'), { recursive: true })
  mkdirSync(path.join(root, 'out', 'renderer', '.vite'), { recursive: true })
  mkdirSync(path.join(root, 'out', 'renderer', 'assets'), { recursive: true })
  writeFileSync(path.join(root, 'out', 'main', 'index.js'), 'main')
  writeFileSync(
    path.join(root, 'out', 'renderer', '.vite', 'manifest.json'),
    JSON.stringify({
      'index.html': { file: 'assets/current-entry.js', imports: ['_current-store.js'] },
      '_current-store.js': { file: 'assets/current-store.js' }
    })
  )
  writeFileSync(path.join(root, 'out', 'renderer', 'assets', 'current-entry.js'), 'entry')
  writeFileSync(path.join(root, 'out', 'renderer', 'assets', 'current-store.js'), storeSource)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('E2E build instrumentation preflight', () => {
  it('accepts store exposure in the current renderer entry graph', () => {
    const root = createOutput('testWindow.__store = useAppStore')

    expect(() => assertE2eBuildInstrumentation(root)).not.toThrow()
  })

  it('rejects existing output without store exposure in the current renderer entry graph', () => {
    const root = createOutput('const productionStore = createStore()')
    writeFileSync(
      path.join(root, 'out', 'renderer', 'assets', 'stale-e2e-store.js'),
      'testWindow.__store = useAppStore'
    )

    expect(() => assertE2eBuildInstrumentation(root)).toThrow(
      /current renderer entry graph does not expose window\.__store/
    )
  })
})
