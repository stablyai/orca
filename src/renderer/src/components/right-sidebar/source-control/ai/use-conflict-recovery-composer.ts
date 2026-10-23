import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  admitSourceControlRecovery,
  sourceControlRecoveryScopeKey
} from '../../source-control-recovery-admission'
import type { SourceControlAiControllerParams } from './controller-types'
import { buildResolveConflictsPrompt } from './prompts'

export function useConflictRecoveryComposer({
  target,
  activeWorktreeId,
  activeConnectionId,
  conflictOperation,
  unresolvedConflicts,
  worktreePath
}: Pick<
  SourceControlAiControllerParams,
  | 'target'
  | 'activeWorktreeId'
  | 'activeConnectionId'
  | 'conflictOperation'
  | 'unresolvedConflicts'
  | 'worktreePath'
>) {
  const context = useMemo(
    () =>
      target && activeWorktreeId && worktreePath
        ? {
            target,
            worktreeId: activeWorktreeId,
            worktreePath,
            connectionId: activeConnectionId ?? undefined
          }
        : null,
    [target, activeWorktreeId, activeConnectionId, worktreePath]
  )
  const scope = context ? sourceControlRecoveryScopeKey(context) : null
  const checkRef = useRef<AbortController | null>(null)
  const [composer, setComposer] = useState<{
    scope: string
    phase: 'checking' | 'open'
  } | null>(null)
  const cancelCheck = useCallback(() => {
    checkRef.current?.abort()
    checkRef.current = null
  }, [])
  useEffect(() => {
    setComposer(null)
    return cancelCheck
  }, [scope, cancelCheck])

  const resolveConflictsPrompt = useMemo(
    () =>
      buildResolveConflictsPrompt({
        conflictOperation,
        entries: unresolvedConflicts,
        worktreePath
      }),
    [conflictOperation, unresolvedConflicts, worktreePath]
  )
  const setResolveConflictsComposerOpen = useCallback(
    (open: boolean): void => {
      cancelCheck()
      setComposer(open && scope ? { scope, phase: 'open' } : null)
    },
    [scope, cancelCheck]
  )
  const handleResolveConflictsWithAI = useCallback(async (): Promise<void> => {
    if (!context || !scope || checkRef.current) {
      return
    }
    if (unresolvedConflicts.length === 0 && conflictOperation === 'unknown') {
      toast.message(
        translate(
          'auto.components.right.sidebar.use.source.control.ai.cfafa92509',
          'No unresolved conflicts to send.'
        )
      )
      return
    }
    const check = new AbortController()
    checkRef.current = check
    setComposer({ scope, phase: 'checking' })
    try {
      const admitted = await admitSourceControlRecovery(context, check.signal)
      if (!check.signal.aborted) {
        setComposer(admitted ? { scope, phase: 'open' } : null)
      }
    } finally {
      if (checkRef.current === check) {
        checkRef.current = null
      }
    }
  }, [context, scope, conflictOperation, unresolvedConflicts.length])

  return {
    resolveConflictsPrompt,
    resolveConflictsRecoveryContext: context,
    resolveConflictsComposerOpen: composer?.scope === scope && composer?.phase === 'open',
    isCheckingRecoveryAdmission: composer?.scope === scope && composer?.phase === 'checking',
    setResolveConflictsComposerOpen,
    handleResolveConflictsWithAI
  }
}
