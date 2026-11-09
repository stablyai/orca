import { describe, expect, it } from 'vitest'
import {
  getCmdExePath,
  getSpawnArgsForWindows,
  wrapWindowsStartWait,
  isWindowsBatchScript,
  UnsafeWindowsBatchArgumentsError
} from './windows-batch-spawn'

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('isWindowsBatchScript', () => {
  it('returns false on non-win32 regardless of extension', () => {
    withPlatform('linux', () => {
      expect(isWindowsBatchScript('/usr/bin/foo.cmd')).toBe(false)
    })
  })
})

describe('getSpawnArgsForWindows', () => {
  it('routes .cmd through cmd.exe with /d /c on win32', () => {
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      withPlatform('win32', () => {
        const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('C:\\tools\\codex.cmd', [
          'login',
          '--foo'
        ])
        expect(spawnCmd).toBe('C:\\Windows\\System32\\cmd.exe')
        // Separate /d and /c arguments avoid Node-escaped quotes reaching cmd.exe.
        expect(spawnArgs).toEqual(['/d', '/c', '@', 'C:\\tools\\codex.cmd', 'login', '--foo'])
      })
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('routes GUI Open In .cmd launches through start /B with an inner cmd /c', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(
        'C:\\Tools\\idea.cmd',
        ['C:\\workspaces\\orca'],
        { detachedGui: true }
      )
      expect(spawnCmd).toBe(getCmdExePath())
      // The inner /d /c prevents start's default cmd /K from leaking a hidden shell.
      // An empty title lets libuv supply the quotes.
      expect(spawnArgs).toEqual([
        '/d',
        '/c',
        'start',
        '',
        '/B',
        getCmdExePath(),
        '/d',
        '/c',
        '@',
        'C:\\Tools\\idea.cmd',
        'C:\\workspaces\\orca'
      ])
      expect(spawnArgs[3]).toBe('')
      expect(spawnArgs).not.toContain('/K')
      expect(spawnArgs).not.toContain('""')
      expect(spawnArgs[spawnArgs.indexOf('/B') + 1]).not.toMatch(/\.(?:cmd|bat)$/i)
    })
  })

  it('wraps an interactive login in start /wait with an empty title argv', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = wrapWindowsStartWait(getCmdExePath(), [
        '/d',
        '/c',
        'C:\\Tools\\claude.cmd',
        'auth',
        'login',
        '--claudeai'
      ])
      expect(spawnCmd).toBe(getCmdExePath())
      expect(spawnArgs).toEqual([
        '/d',
        '/c',
        'start',
        '',
        '/wait',
        getCmdExePath(),
        '/d',
        '/c',
        'C:\\Tools\\claude.cmd',
        'auth',
        'login',
        '--claudeai'
      ])
      expect(spawnArgs[3]).toBe('')
      expect(spawnArgs).not.toContain('/B')
      expect(spawnArgs).not.toContain('""')
    })
  })

  it('rejects cmd metacharacters in executable paths passed through start /wait', () => {
    expect(() => wrapWindowsStartWait('C:\\Users\\A%B\\codex.exe', ['login'])).toThrow(
      UnsafeWindowsBatchArgumentsError
    )
    expect(() => wrapWindowsStartWait('C:\\Tools\\codex.exe', ['log&in'])).toThrow(
      UnsafeWindowsBatchArgumentsError
    )
  })

  it('leaves .exe GUI launches alone even when detachedGui is requested', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(
        'C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe',
        ['C:\\workspaces\\orca'],
        { detachedGui: true }
      )
      expect(spawnCmd).toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe')
      expect(spawnArgs).toEqual(['C:\\workspaces\\orca'])
    })
  })

  it('preserves VS Code WSL remote arguments with spaces through .cmd launchers', () => {
    withPlatform('win32', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('C:\\tools\\code.cmd', [
        '--remote',
        'wsl+Ubuntu Preview',
        '/home/Ada Lovelace/project'
      ])

      expect(spawnCmd).toBe(getCmdExePath())
      expect(spawnArgs).toEqual([
        '/d',
        '/c',
        '@',
        'C:\\tools\\code.cmd',
        '--remote',
        'wsl+Ubuntu Preview',
        '/home/Ada Lovelace/project'
      ])
    })
  })

  it('passes posix paths through unchanged on non-win32', () => {
    withPlatform('darwin', () => {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows('/usr/local/bin/codex', ['login'])
      expect(spawnCmd).toBe('/usr/local/bin/codex')
      expect(spawnArgs).toEqual(['login'])
    })
  })

  it('rejects unsafe args for .cmd scripts on win32', () => {
    withPlatform('win32', () => {
      for (const argument of ['hello & goodbye', 'a | b', 'x > y', '%PATH%', 'a\nb']) {
        expect(() => getSpawnArgsForWindows('C:\\tools\\agent.cmd', [argument])).toThrow(
          'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
        )
      }
    })
  })

  it('rejects unsafe command paths for .cmd scripts on win32', () => {
    withPlatform('win32', () => {
      expect(() => getSpawnArgsForWindows('C:\\bad&path\\agent.cmd', ['login'])).toThrow(
        'UNSAFE_WINDOWS_BATCH_ARGUMENTS'
      )
    })
  })

  // Parentheses cannot chain a command without a separator the guard already rejects.
  it('spawns .cmd shims under Program Files (x86) and paren-bearing worktrees', () => {
    withPlatform('win32', () => {
      const npx = 'C:\\Program Files (x86)\\nodejs\\npx.cmd'
      expect(getSpawnArgsForWindows(npx, ['C:\\dev\\app (fork)'])).toEqual({
        spawnCmd: getCmdExePath(),
        spawnArgs: ['/d', '/c', '@', npx, 'C:\\dev\\app (fork)']
      })
      expect(getSpawnArgsForWindows('C:\\tools\\agent.cmd', ['close)', '(open']).spawnArgs).toEqual(
        ['/d', '/c', '@', 'C:\\tools\\agent.cmd', 'close)', '(open']
      )
    })
  })
})
