import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('landing preflight runtime ownership boundary', () => {
  it('routes the landing preflight banner through the preflight slice', () => {
    const text = source('src/renderer/src/components/Landing.tsx')

    expect(text).toContain('refreshPreflightStatus')
    expect(text).toContain('s.preflightStatus')
  })

  // Why: window.api.preflight.check always probes the local client. The
  // preflight slice is the only caller that consults getActiveRuntimeTarget and
  // forwards to `preflight.check` on the active runtime environment, so a
  // direct IPC call here would silently report the client's git/gh state while
  // the user is connected to a remote runtime.
  it('never calls the local preflight IPC directly', () => {
    const text = source('src/renderer/src/components/Landing.tsx')

    expect(text).not.toContain('window.api.preflight')
  })

  it('keeps the preflight slice as the runtime-aware routing point', () => {
    const text = source('src/renderer/src/store/slices/preflight.ts')

    expect(text).toContain('getActiveRuntimeTarget')
    expect(text).toContain("'preflight.check'")
  })
})
