import { afterEach, describe, expect, it } from 'vitest'
import { pluginGitConfigArgs } from './plugin-git-arguments'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
}

/** Whether the argv asks Git to accept paths past the Windows 260-character limit. */
function asksForLongPaths(args: string[]): boolean {
  return args.join(' ').includes('core.longpaths=true')
}

describe('pluginGitConfigArgs', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('asks for long paths when a Windows plugin clone writes a deep tree', () => {
    const shortCheckout = 'C:\\checkout\\repository'

    expect(withPlatform('win32', () => asksForLongPaths(pluginGitConfigArgs('/tmp/no-hooks', shortCheckout)))).toBe(
      true
    )
  })

  it('leaves the flag off where Windows long paths do not apply', () => {
    expect(withPlatform('linux', () => asksForLongPaths(pluginGitConfigArgs('/tmp/no-hooks', '/tmp/repository')))).toBe(
      false
    )
    // A WSL UNC path is served by the distro's Linux Git, which does not read core.longpaths.
    expect(
      withPlatform('win32', () =>
        asksForLongPaths(pluginGitConfigArgs('/tmp/no-hooks', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'))
      )
    ).toBe(false)
  })

  it('keeps the hooks path and protocol policy alongside the long-path flag', () => {
    const args = withPlatform('win32', () => pluginGitConfigArgs('/tmp/no-hooks', 'C:\\checkout'))

    expect(args).toContain('core.hooksPath=/tmp/no-hooks')
    expect(args).toContain('protocol.https.allow=always')
    expect(args.filter((arg) => arg === '-c').length).toBe(args.length / 2)
  })
})
