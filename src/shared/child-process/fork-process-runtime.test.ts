import { afterEach, describe, expect, it, vi } from 'vitest'
const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork }))
import { forkProcess } from './fork-process'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('owned fork dotenv isolation', () => {
  it('disables dotenv in same-runtime Bun helpers while preserving other arguments', () => {
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, bun: '1.4.2' },
      execArgv: ['--inspect', '--no-env-file', '--config=foreign.toml']
    })
    forkProcess({ modulePath: '/helper.js' })
    expect(fork).toHaveBeenCalledWith(
      '/helper.js',
      [],
      expect.objectContaining({
        execArgv: [
          '--inspect',
          '--no-env-file',
          process.platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
          '--no-install'
        ]
      })
    )
  })
  it.each(['--config', '-c'])(
    'replaces an inherited %s path without dropping later flags',
    (flag) => {
      vi.stubGlobal('process', {
        ...process,
        versions: { ...process.versions, bun: '1.4.2' },
        execArgv: [flag, 'foreign.toml', '--inspect']
      })
      forkProcess({ modulePath: '/helper.js' })
      expect(fork.mock.calls[0][2].execArgv).toEqual([
        '--inspect',
        '--no-env-file',
        process.platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
        '--no-install'
      ])
    }
  )
  it('does not pass Bun flags to an explicitly selected Node or Electron binary', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: '1.4.2' } })
    forkProcess({ modulePath: '/helper.js', execPath: '/other/node' })
    expect(fork.mock.calls[0][2]).not.toHaveProperty('execArgv')
  })
  it('preserves ordinary Node fork argument inheritance', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: undefined } })
    forkProcess({ modulePath: '/helper.js' })
    expect(fork.mock.calls[0][2]).not.toHaveProperty('execArgv')
  })
})
