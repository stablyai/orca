import { useEffect, useMemo, useState } from 'react'
import { normalizeLiteralPathQuery } from '../../../shared/quick-open-literal-path'
import type { ParsedFileLinkLocation } from '../../../shared/file-link-location'
import { resolveExplicitFileLinkTarget } from '@/lib/explicit-file-link-target'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOperationRoute
} from './right-sidebar/file-explorer-operation-owner'
import {
  isRemoteRuntimeFileOperation,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { runtimePathsExist } from '@/runtime/runtime-path-existence-batch'
import { debounceRuntimeFileRequest } from '@/runtime/runtime-file-request-debounce'

export type QuickOpenLiteralPathTarget = ParsedFileLinkLocation & {
  absolutePath: string
  /** The trimmed palette query, shown verbatim on the pinned row. */
  queryText: string
}

const LITERAL_PATH_CHECK_DEBOUNCE_MS = 120

/** Host-routed existence check; the local/remote split mirrors terminal-path-existence-batch. */
export async function quickOpenLiteralPathExists(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<boolean> {
  const remote = isRemoteRuntimeFileOperation(context, absolutePath)
  if (context.connectionId || remote) {
    const [result] = await runtimePathsExist(context, [absolutePath])
    return result !== undefined && 'exists' in result && result.exists
  }
  return await window.api.shell.pathExists(absolutePath)
}

export function getQuickOpenLiteralPathContext(
  worktreeId: string,
  worktreePath: string
): RuntimeFileOperationArgs | null {
  const route = getFileExplorerOperationRoute(getFileExplorerOperationOwner(worktreeId))
  if (!route) {
    return null
  }
  return {
    settings: { activeRuntimeEnvironmentId: route.settings.activeRuntimeEnvironmentId },
    worktreeId,
    worktreePath,
    connectionId: route.connectionId
  }
}

/**
 * Resolves a path-like palette query to an absolute path (terminal-link rules:
 * worktree-rooted relatives, host-home tildes) and confirms it exists on the
 * host that owns the active worktree before the pinned row appears.
 */
export function useQuickOpenLiteralPathTarget({
  enabled,
  query,
  worktreeId,
  worktreePath
}: {
  enabled: boolean
  query: string
  worktreeId: string | null
  worktreePath: string | null
}): QuickOpenLiteralPathTarget | null {
  const resolved = useMemo<QuickOpenLiteralPathTarget | null>(() => {
    if (!enabled || !worktreeId || !worktreePath) {
      return null
    }
    const parsed = normalizeLiteralPathQuery(query)
    if (!parsed) {
      return null
    }
    const target = resolveExplicitFileLinkTarget(parsed, worktreePath, null)
    if (!target) {
      return null
    }
    return {
      pathText: parsed.pathText,
      line: target.line,
      column: target.column,
      absolutePath: target.absolutePath,
      queryText: query.trim()
    }
  }, [enabled, query, worktreeId, worktreePath])

  const [confirmed, setConfirmed] = useState<QuickOpenLiteralPathTarget | null>(null)

  useEffect(() => {
    if (!resolved || !worktreeId || !worktreePath) {
      setConfirmed(null)
      return
    }
    const context = getQuickOpenLiteralPathContext(worktreeId, worktreePath)
    if (!context) {
      setConfirmed(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    void debounceRuntimeFileRequest(LITERAL_PATH_CHECK_DEBOUNCE_MS, controller.signal, () =>
      quickOpenLiteralPathExists(context, resolved.absolutePath)
    )
      .then((exists) => {
        if (!cancelled) {
          setConfirmed(exists ? resolved : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfirmed(null)
        }
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [resolved, worktreeId, worktreePath])

  if (
    !confirmed ||
    !resolved ||
    confirmed.absolutePath !== resolved.absolutePath ||
    confirmed.line !== resolved.line ||
    confirmed.column !== resolved.column
  ) {
    return null
  }
  return confirmed
}
