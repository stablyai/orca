import { describe, expect, it } from 'vitest'
import { withFreshOmpLaunch } from './omp-fresh-launch'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('OMP fresh launch intent', () => {
  it.each(['omp', 'omp launch', 'omp --model provider/model', 'omp --config user.yml'])(
    '%s adds the final overlay',
    (command) => {
      expect(withFreshOmpLaunch(command, 'posix')).toContain(
        `${command} --config "$ORCA_OMP_FRESH_CONFIG"`
      )
    }
  )
  it.each([
    'omp --resume id',
    'omp -r id',
    'omp --continue',
    'omp -c',
    'omp --session-dir /custom',
    'omp --no-session',
    'omp --fork id',
    'omp models',
    'omp config',
    'omp wt',
    'omp --help',
    'omp --unknown foo',
    'omp --model',
    'omp -- hello',
    'echo omp',
    'omp && echo hi',
    'omp --model foo;',
    'omp --model $(preferred-model)',
    'omp --model `preferred-model`'
  ])('preserves %s', (command) => {
    expect(withFreshOmpLaunch(command, 'posix')).toBe(command)
  })
  it.each(['cmd', 'powershell'] as const)('preserves compound values in %s', (shell) => {
    const command = 'omp --model foo&'
    expect(withFreshOmpLaunch(command, shell)).toBe(command)
  })
  it('quotes the host config path for each Windows shell', () => {
    expect(withFreshOmpLaunch('omp', 'powershell')).toContain(
      'omp --config "$env:ORCA_OMP_FRESH_CONFIG"'
    )
    expect(withFreshOmpLaunch('omp', 'cmd')).toContain('omp --config "%ORCA_OMP_FRESH_CONFIG%"')
  })
  it('keeps fresh intent out of saved resume command and environment', () => {
    const plan = buildAgentStartupPlan({
      agent: 'omp',
      prompt: 'new task',
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(plan?.launchCommand).toContain('--config "$ORCA_OMP_FRESH_CONFIG"')
    expect(JSON.stringify(plan?.launchConfig)).not.toContain('ORCA_OMP_FRESH_CONFIG')
    expect(plan?.env).toBeUndefined()
  })
  it('requires host-owned configuration for fresh SSH launches', () => {
    const plan = buildAgentStartupPlan({
      agent: 'omp',
      prompt: 'new task',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true
    })
    expect(plan?.launchCommand).toContain('test -f "$ORCA_OMP_FRESH_CONFIG"')
  })
})
