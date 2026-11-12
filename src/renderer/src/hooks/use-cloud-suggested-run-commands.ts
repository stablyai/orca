// In an Orca Cloud workspace the Run menu suggests the project's own scripts (JA-31): typecheck,
// lint, test and friends from package.json, run with the package manager the project declares.
// Suggestions run like saved quick commands but are not saved; nothing is offered when the file is
// missing or unreadable.
import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import { hasWorktreeSleepIntent } from '@/lib/workspace/sleep/worktree-sleep-intent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { HostedTerminalQuickCommand } from './use-terminal-quick-command-hosts'

/** The scripts worth a one-click run, in menu order. */
export const SUGGESTED_SCRIPTS = ['test', 'typecheck', 'lint', 'build', 'dev'] as const

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function packageManagerOf(pkg: Record<string, unknown>): PackageManager {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : ''
  const name = declared.split('@')[0]
  return name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : 'npm'
}

/** Pure: package.json text to the commands to suggest (empty on anything unexpected). */
export function suggestedRunCommands(
  packageJsonText: string,
  host: { hostId: ExecutionHostId; label: string }
): HostedTerminalQuickCommand[] {
  let pkg: unknown
  try {
    pkg = JSON.parse(packageJsonText)
  } catch {
    return []
  }
  if (!isRecord(pkg) || !isRecord(pkg.scripts)) {
    return []
  }
  const scripts = pkg.scripts
  const pm = packageManagerOf(pkg)
  return SUGGESTED_SCRIPTS.filter((name) => typeof scripts[name] === 'string').map((name) => {
    const id = `suggested-script-${name}`
    return {
      command: {
        id,
        label: name,
        command: pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`,
        appendEnter: true
      },
      hostId: host.hostId,
      hostLabel: host.label,
      key: `${host.hostId}\0${id}`,
      suggested: true
    }
  })
}

const EMPTY: HostedTerminalQuickCommand[] = []

/** At most one refresh read per workspace in this window; menu opens and hovers don't spam the host. */
export const SUGGESTION_REFRESH_MIN_MS = 5_000
const lastReadAtByWorktree = new Map<string, number>()

export function resetSuggestionRefreshThrottleForTest(): void {
  lastReadAtByWorktree.clear()
}

/** Same suggestions (same command lines): keep the old array so the menu doesn't re-render. */
function sameSuggestions(
  a: readonly HostedTerminalQuickCommand[],
  b: readonly HostedTerminalQuickCommand[]
): boolean {
  const line = (entry: HostedTerminalQuickCommand): string =>
    `${entry.key}\0${'command' in entry.command ? entry.command.command : ''}`
  return a.length === b.length && a.every((entry, index) => line(entry) === line(b[index]))
}

/**
 * Suggestions for one cloud workspace; [] until read, and for anything that isn't cloud.
 * package.json can change any time (a new script, a file created mid-session), so it is read
 * again by `refresh` (the Run menu calls it on open and on hover) and when the window regains
 * focus, not only when the tab bar mounts (LC2-P3).
 */
export function useCloudSuggestedRunCommands(
  worktreeId: string,
  cloudHost: { hostId: ExecutionHostId; label: string; environmentId: string } | null
): { commands: HostedTerminalQuickCommand[]; refresh: () => void } {
  const [commands, setCommandsRaw] = useState<HostedTerminalQuickCommand[]>(EMPTY)
  const [generation, setGeneration] = useState(0)
  // Reads only reach a sandbox that is up: never one asleep, going to sleep or waking, so a
  // suggestion read can never be what wakes it (a VM record not running, or a wake in flight).
  const sandboxUp = useAppStore((state) => {
    const runtime = state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId]
    return (
      (runtime === undefined || runtime.status === 'running') &&
      !state.wakingEphemeralVmWorkspaceIds?.[worktreeId]
    )
  })
  const refresh = useCallback(() => {
    const last = lastReadAtByWorktree.get(worktreeId)
    if (last !== undefined && Date.now() - last < SUGGESTION_REFRESH_MIN_MS) {
      return
    }
    setGeneration((value) => value + 1)
  }, [worktreeId])
  const setCommands = useCallback((next: HostedTerminalQuickCommand[]) => {
    setCommandsRaw((previous) => (sameSuggestions(previous, next) ? previous : next))
  }, [])
  const worktreePath = useAppStore((state) => findWorktreeById(state, worktreeId)?.path ?? null)
  const hostId = cloudHost?.hostId ?? null
  const label = cloudHost?.label ?? ''
  const environmentId = cloudHost?.environmentId ?? null
  useEffect(() => {
    if (!hostId || !environmentId || !worktreePath) {
      setCommands(EMPTY)
      return
    }
    // Asleep or on its way: keep what was last read; the next refresh after the wake reads again.
    if (!sandboxUp || hasWorktreeSleepIntent(worktreeId)) {
      return
    }
    lastReadAtByWorktree.set(worktreeId, Date.now())
    let cancelled = false
    void readRuntimeFileContent({
      target: { kind: 'environment', environmentId },
      filePath: `${worktreePath.replace(/\/+$/, '')}/package.json`,
      relativePath: 'package.json',
      worktreeId
    })
      .then((file) => {
        if (!cancelled) {
          setCommands(
            file.isBinary || !file.content
              ? []
              : suggestedRunCommands(file.content, { hostId, label })
          )
        }
      })
      .catch((error: unknown) => {
        // A repo without package.json is normal; anything else is worth a line in the console.
        if (!/ENOENT|not.?found|no such file/i.test(String(error))) {
          console.warn('[run-suggestions] could not read package.json', error)
        }
        if (!cancelled) {
          setCommands([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, generation, hostId, label, sandboxUp, setCommands, worktreeId, worktreePath])
  useEffect(() => {
    if (!hostId) {
      return
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [hostId, refresh])
  return { commands, refresh }
}
