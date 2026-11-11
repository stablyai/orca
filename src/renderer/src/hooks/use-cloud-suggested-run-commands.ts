// In an Orca Cloud workspace the Run menu suggests the project's own scripts (JA-31): typecheck,
// lint, test and friends from package.json, run with the package manager the project declares.
// Suggestions run like saved quick commands but are not saved; nothing is offered when the file is
// missing or unreadable.
import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
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

/** Suggestions for one cloud workspace; [] until read, and for anything that isn't cloud. */
export function useCloudSuggestedRunCommands(
  worktreeId: string,
  cloudHost: { hostId: ExecutionHostId; label: string; environmentId: string } | null
): HostedTerminalQuickCommand[] {
  const [commands, setCommands] = useState<HostedTerminalQuickCommand[]>([])
  const worktreePath = useAppStore((state) => findWorktreeById(state, worktreeId)?.path ?? null)
  const hostId = cloudHost?.hostId ?? null
  const label = cloudHost?.label ?? ''
  const environmentId = cloudHost?.environmentId ?? null
  useEffect(() => {
    if (!hostId || !environmentId || !worktreePath) {
      setCommands([])
      return
    }
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
  }, [environmentId, hostId, label, worktreeId, worktreePath])
  return commands
}
