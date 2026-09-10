import { describe, expect, it } from 'vitest'
import {
  createManagedCliContext,
  managedCliContextFromEnv,
  managedCliContextToEnv,
  resolveManagedCliExecutable
} from './managed-cli-context'

describe('managed CLI context', () => {
  it('round-trips exact identities through environment variables', () => {
    const context = createManagedCliContext({
      executable: '/opt/orca/bin/orca',
      runtimeId: 'runtime-01',
      executionHostId: 'ssh:host%3A22',
      workspaceKey: 'worktree:repo::/srv/work tree',
      terminalHandle: 'term_abc'
    })
    expect(managedCliContextFromEnv(managedCliContextToEnv(context))).toEqual(context)
  })

  it('rejects partial or capability-mismatched contexts', () => {
    expect(managedCliContextFromEnv({ ORCA_MANAGED_CLI_EXECUTABLE: 'orca' })).toBeNull()
    expect(
      managedCliContextFromEnv({
        ORCA_MANAGED_CLI_EXECUTABLE: 'orca',
        ORCA_MANAGED_CLI_RUNTIME_ID: 'runtime',
        ORCA_MANAGED_CLI_EXECUTION_HOST_ID: 'local',
        ORCA_MANAGED_CLI_WORKSPACE_KEY: 'folder:f',
        ORCA_MANAGED_CLI_TERMINAL_HANDLE: 'term_a',
        ORCA_MANAGED_CLI_PROTOCOL_CAPABILITY: 'future.v1'
      })
    ).toBeNull()
  })

  it('preserves a Windows path with spaces byte-for-byte with no shell quoting applied', () => {
    const context = createManagedCliContext({
      executable: 'C:\\Program Files\\Orca\\orca.exe',
      runtimeId: 'runtime-01',
      executionHostId: 'local',
      workspaceKey: 'worktree:repo::C:\\work tree',
      terminalHandle: 'term_win'
    })
    // Why: env vars are never shell-parsed, so a raw unquoted space must
    // survive round-tripping exactly — no wrapping quotes, no escaping.
    expect(context.executable).toBe('C:\\Program Files\\Orca\\orca.exe')
    expect(managedCliContextFromEnv(managedCliContextToEnv(context))).toEqual(context)
  })

  it.each([
    ['an embedded newline that could forge an extra preamble line', 'value\nforged: x'],
    ['a tab', 'value\twith-tab'],
    ['a NUL byte', 'value\u0000with-nul'],
    ['a DEL byte', 'value\u007fwith-del']
  ])('rejects a field containing %s', (_label, value) => {
    expect(() =>
      createManagedCliContext({
        executable: value,
        runtimeId: 'runtime-01',
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::/srv/work',
        terminalHandle: 'term_abc'
      })
    ).toThrow('managed_cli_context_executable_invalid')
  })

  it('rejects a field longer than the bound', () => {
    expect(() =>
      createManagedCliContext({
        executable: 'x'.repeat(4097),
        runtimeId: 'runtime-01',
        executionHostId: 'local',
        workspaceKey: 'worktree:repo::/srv/work',
        terminalHandle: 'term_abc'
      })
    ).toThrow('managed_cli_context_executable_too_long')
  })

  it('chooses a safe Linux command and preserves an installed launcher path', () => {
    expect(resolveManagedCliExecutable({ platform: 'linux', isPackaged: true })).toBe('orca-ide')
    expect(
      resolveManagedCliExecutable({
        platform: 'linux',
        isPackaged: true,
        launcherPath: '/srv/.orca-relay/bin/orca'
      })
    ).toBe('/srv/.orca-relay/bin/orca')
  })
})
