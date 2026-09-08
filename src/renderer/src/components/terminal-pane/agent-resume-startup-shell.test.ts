import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The host-authority resume request must carry the shell the pane actually
 * runs. Without it the host resolves the shell from the global
 * `terminalWindowsShell` setting alone, so a tab with a per-tab override is
 * quoted for the wrong shell after an app restart (#12320, #13095).
 *
 * The value must also be withheld whenever the client cannot classify the
 * target, so the host keeps its own platform-aware resolution.
 */

const storeState: {
  tabsByWorktree: Record<string, { id: string; shellOverride?: string }[]>
  settings?: { terminalWindowsShell?: string | null }
  worktreesByRepo: unknown
} = { tabsByWorktree: {}, settings: {}, worktreesByRepo: {} }

let connectionId: string | null = null
let executionHostId: string | null = 'local'
let worktreePath: string | undefined = 'C:\\repo\\feature'

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => connectionId }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => executionHostId
}))
vi.mock('@/store/worktree-repo-index', () => ({
  getIndexedWorktreeById: () => (worktreePath ? { path: worktreePath } : undefined)
}))

function setNavigatorUserAgent(userAgent: string): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: userAgent.includes('Windows') ? 'Win32' : 'MacIntel', userAgent }
  })
  return () => {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original)
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator
    }
  }
}

async function resolveShell(args: {
  tabShellOverride?: string
  globalShell?: string | null
  worktreeId?: string | undefined
}): Promise<string | undefined> {
  storeState.tabsByWorktree = {
    'wt-1': [
      { id: 'tab-1', ...(args.tabShellOverride ? { shellOverride: args.tabShellOverride } : {}) }
    ]
  }
  storeState.settings = { terminalWindowsShell: args.globalShell ?? null }
  const { resolveAgentResumeStartupShellForPane } = await import('./agent-resume-startup-shell')
  return resolveAgentResumeStartupShellForPane(
    'worktreeId' in args ? args.worktreeId : 'wt-1',
    'tab-1'
  )
}

describe('resolveAgentResumeStartupShellForPane on a local Windows pane', () => {
  let restoreNavigator: () => void

  beforeEach(() => {
    vi.resetModules()
    connectionId = null
    executionHostId = 'local'
    worktreePath = 'C:\\repo\\feature'
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  it('prefers the per-tab override over the global setting', async () => {
    expect(await resolveShell({ tabShellOverride: 'cmd.exe', globalShell: 'powershell.exe' })).toBe(
      'cmd'
    )
    expect(
      await resolveShell({ tabShellOverride: 'git-bash', globalShell: 'powershell.exe' })
    ).toBe('posix')
    expect(await resolveShell({ tabShellOverride: 'powershell.exe', globalShell: 'cmd.exe' })).toBe(
      'powershell'
    )
  })

  it('falls back to the global setting when the tab has no override', async () => {
    expect(await resolveShell({ globalShell: 'cmd.exe' })).toBe('cmd')
    expect(await resolveShell({ globalShell: 'wsl.exe' })).toBe('posix')
  })

  it('returns undefined without a worktree so the host keeps its own resolution', async () => {
    expect(
      await resolveShell({ tabShellOverride: 'cmd.exe', worktreeId: undefined })
    ).toBeUndefined()
  })
})

describe('resolveAgentResumeStartupShellForPane withholds a shell it cannot classify', () => {
  let restoreNavigator: () => void

  beforeEach(() => {
    vi.resetModules()
    connectionId = null
    executionHostId = 'local'
    worktreePath = 'C:\\repo\\feature'
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  it('sends nothing for a WSL worktree, which runs a POSIX shell', async () => {
    worktreePath = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\repo'
    expect(await resolveShell({ tabShellOverride: 'cmd.exe' })).toBeUndefined()
  })

  it('sends nothing for an SSH workspace', async () => {
    connectionId = 'conn-1'
    expect(await resolveShell({ tabShellOverride: 'cmd.exe' })).toBeUndefined()
  })

  it('sends nothing for a non-local execution host', async () => {
    executionHostId = 'environment:env-1'
    expect(await resolveShell({ tabShellOverride: 'cmd.exe' })).toBeUndefined()
  })
})

describe('resolveAgentResumeStartupShellForPane on a non-Windows client', () => {
  let restoreNavigator: () => void

  beforeEach(() => {
    vi.resetModules()
    connectionId = null
    executionHostId = 'local'
    worktreePath = '/home/dev/repo'
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  it('sends no shell, leaving the platform default in place', async () => {
    expect(
      await resolveShell({ tabShellOverride: 'cmd.exe', globalShell: 'cmd.exe' })
    ).toBeUndefined()
  })
})
