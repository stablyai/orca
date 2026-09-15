import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: mounting the full terminal surface costs far more than the startup wiring assertion returns.
const TERMINAL_PATH = 'src/renderer/src/components/use-terminal-watcher-effects.ts'

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('Terminal startup recovery wiring', () => {
  const source = readSource(TERMINAL_PATH)

  it('routes startup materialization through the recovery boundary', () => {
    expect(source.split('recoverWorkspaceActivation(').length - 1).toBe(1)
    expect(source.split('startWorkspaceActivationSurfaceProducer(').length - 1).toBe(1)
    expect(source).toContain(
      "startWorkspaceActivationSurfaceProducer(identity, { mode: 'startup' })"
    )
    expect(source).toContain('signal: abort.signal')
  })

  it('captures target, host, runtime, and attempt identity', () => {
    expect(source).toContain('workspaceKey: activeWorktreeId')
    expect(source).toContain('getExecutionHostIdForWorktree(state, activeWorktreeId)')
    expect(source).toContain('getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)')
    expect(source).toContain('attemptId: createBrowserUuid()')
  })

  it('re-arms startup ownership for every route and authority transition', () => {
    expect(source).toContain('const startupRecoveryTargetRef = useRef<string | null>(null)')
    expect(source).toContain('activeRuntimeRoute.revision,')
    expect(source).toContain('const target = JSON.stringify([')
    expect(source).toContain('startupRecoveryTargetRef.current = null')
    expect(source).toContain('return () => {\n      abort.abort()')
  })
})
