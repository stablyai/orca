import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from './orca-yaml'
import {
  effectiveRunMode,
  formatRunActionsForTrust,
  isRunActionAvailableOn,
  pickAutoRunAction,
  pickDefaultRunAction
} from './orca-yaml-run-actions'

describe('orca.yaml scripts.run', () => {
  it('parses named actions with cwd, env, default and modes', () => {
    const hooks = parseOrcaYaml(`
scripts:
  setup: pnpm install
  runMode: nonconcurrent
  autoRunAfterSetup: true
  run:
    web:
      command: pnpm dev --port $ORCA_PORT
      cwd: apps/web
      env: { NODE_ENV: development, DEBUG: 1 }
      default: true
    api-server:
      command: pnpm api --port $((ORCA_PORT + 1))
      runMode: concurrent
      availableIn: [local, cloud]
`)
    expect(hooks?.scripts.run).toEqual([
      {
        id: 'web',
        name: 'Web',
        command: 'pnpm dev --port $ORCA_PORT',
        cwd: 'apps/web',
        env: { NODE_ENV: 'development', DEBUG: '1' },
        default: true
      },
      {
        id: 'api-server',
        name: 'Api server',
        command: 'pnpm api --port $((ORCA_PORT + 1))',
        runMode: 'concurrent',
        availableIn: ['local', 'remote']
      }
    ])
    expect(hooks?.scripts.runMode).toBe('nonconcurrent')
    expect(hooks?.scripts.autoRunAfterSetup).toBe(true)
  })

  it('accepts the bare-string form and snake_case keys', () => {
    const hooks = parseOrcaYaml(`
scripts:
  run: npm run dev -- --port $CONDUCTOR_PORT
  run_mode: nonconcurrent
  auto_run_after_setup: true
`)
    expect(hooks?.scripts.run).toEqual([
      { id: 'run', name: 'Run', command: 'npm run dev -- --port $CONDUCTOR_PORT' }
    ])
    expect(hooks?.scripts.runMode).toBe('nonconcurrent')
  })

  it('keeps a file with only run actions', () => {
    expect(parseOrcaYaml('scripts:\n  run:\n    dev: vite\n')?.scripts.run?.[0]?.command).toBe(
      'vite'
    )
  })

  it('drops hidden, command-less, escaping-cwd and badly named actions', () => {
    const hooks = parseOrcaYaml(`
scripts:
  run:
    hidden: { command: x, hide: true }
    empty: { cwd: web }
    escape: { command: y, cwd: ../other }
    "-bad": z
    ok: { command: w, cwd: /abs }
`)
    expect(hooks?.scripts.run).toEqual([
      { id: 'escape', name: 'Escape', command: 'y' },
      { id: 'ok', name: 'Ok', command: 'w' }
    ])
  })

  it('ignores autoRunAfterSetup without actions and invalid modes', () => {
    const hooks = parseOrcaYaml(
      'scripts:\n  setup: a\n  runMode: sometimes\n  autoRunAfterSetup: true\n'
    )
    expect(hooks?.scripts).toEqual({ setup: 'a' })
  })

  it('picks default, auto-run and mode', () => {
    const run = [
      { id: 'a', name: 'A', command: 'a' },
      { id: 'b', name: 'B', command: 'b', default: true, runMode: 'nonconcurrent' as const }
    ]
    expect(pickDefaultRunAction(run)?.id).toBe('b')
    expect(pickDefaultRunAction([run[0]])?.id).toBe('a')
    expect(pickAutoRunAction({ run, autoRunAfterSetup: true })?.id).toBe('b')
    expect(pickAutoRunAction({ run, autoRunAfterSetup: 'a' })?.id).toBe('a')
    expect(pickAutoRunAction({ run, autoRunAfterSetup: 'missing' })).toBeNull()
    expect(effectiveRunMode(run[0], {})).toBe('concurrent')
    expect(effectiveRunMode(run[0], { runMode: 'nonconcurrent' })).toBe('nonconcurrent')
    expect(effectiveRunMode(run[1], { runMode: 'concurrent' })).toBe('nonconcurrent')
    expect(isRunActionAvailableOn({ availableIn: ['local'] }, 'remote')).toBe(false)
    expect(isRunActionAvailableOn({}, 'remote')).toBe(true)
  })

  it('formats every command, cwd and env into the trust text', () => {
    expect(
      formatRunActionsForTrust([
        { id: 'web', name: 'Web', command: 'pnpm dev', cwd: 'apps/web', env: { A: '1' } }
      ])
    ).toBe('# Web (web)\ncd apps/web\nexport A="1"\npnpm dev')
  })
})
