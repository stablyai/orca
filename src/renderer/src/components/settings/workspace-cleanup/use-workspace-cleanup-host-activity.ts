import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/rpc/targets/runtime-client-target'
import { onWorkspaceCleanupRunFinished } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/runtime-rpc-error-code'
import { errorMessage } from '../../../../../shared/error-message'
import {
  hasEnabledWorkspaceCleanupRule,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupReport
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'

// The host reads Git state for every workspace before it answers; matches the CLI's wait.
const EVALUATE_TIMEOUT_MS = 10 * 60 * 1000
const REPORT_TIMEOUT_MS = 30_000

export type WorkspaceCleanupHostReport =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'error'; message: string }
  /** `readAt` is when the report was read; relative times are shown as of then. */
  | { state: 'ready'; report: WorkspaceCleanupReport; readAt: number }

/** What the selected host's runner did and would do now; refreshed when it finishes a run. */
export function useWorkspaceCleanupHostActivity(
  owner: RuntimeClientTarget,
  rules: WorkspaceCleanupRules | null
): {
  hostReport: WorkspaceCleanupHostReport
  /** What the host's current rules match now; null until read or while no rule is on. */
  preview: WorkspaceCleanupPreview | null
  cleaningUp: boolean
  cleanUpNow: () => Promise<void>
  previewRules: (rules: WorkspaceCleanupRules) => Promise<WorkspaceCleanupPreview>
  /** Makes a preview of rules that were just saved the page's matches, instead of scanning them again. */
  adoptPreview: (rules: WorkspaceCleanupRules, preview: WorkspaceCleanupPreview) => void
} {
  const t = useTranslate()
  const environmentId = runtimeTargetEnvironmentId(owner)
  const ownerKey = environmentId ?? 'local'
  const rulesKey = rules ? JSON.stringify(rules) : null
  const anyRuleOn = rules ? hasEnabledWorkspaceCleanupRule(rules) : false
  const [reportState, setReportState] = useState<{
    ownerKey: string
    hostReport: WorkspaceCleanupHostReport
  } | null>(null)
  // Keyed by the rules it evaluated, so a rule change never shows the old rules' matches.
  const [previewState, setPreviewState] = useState<{
    ownerKey: string
    rulesKey: string
    revision: number
    preview: WorkspaceCleanupPreview
  } | null>(null)
  const [cleaningUp, setCleaningUp] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(
    () =>
      onWorkspaceCleanupRunFinished((detail) => {
        if ((detail.environmentId ?? 'local') === ownerKey) {
          setRevision((value) => value + 1)
        }
      }),
    [ownerKey]
  )

  useEffect(() => {
    // Read once the rules are in: their arrival would otherwise read the report a second time.
    if (!rulesKey) {
      return
    }
    let current = true
    const target = runtimeTargetForOwnerEnvironment(environmentId)
    void callRuntimeRpc<WorkspaceCleanupReport>(target, 'workspaceCleanup.report', undefined, {
      timeoutMs: REPORT_TIMEOUT_MS
    }).then(
      (report) => {
        if (current) {
          setReportState({ ownerKey, hostReport: { state: 'ready', report, readAt: Date.now() } })
        }
      },
      (error: unknown) => {
        if (current) {
          setReportState({
            ownerKey,
            hostReport: hasRuntimeRpcErrorCode(error, 'method_not_found')
              ? { state: 'unsupported' }
              : { state: 'error', message: errorMessage(error) }
          })
        }
      }
    )
    return () => {
      current = false
    }
    // A rule change reschedules the next run, so the report is read again with the rules.
  }, [environmentId, ownerKey, rulesKey, revision])

  const previewIsCurrent =
    previewState?.ownerKey === ownerKey &&
    previewState.rulesKey === rulesKey &&
    previewState.revision === revision
  useEffect(() => {
    // A rule change already previewed its rules before saving them.
    if (!anyRuleOn || !rulesKey || previewIsCurrent) {
      return
    }
    let current = true
    const target = runtimeTargetForOwnerEnvironment(environmentId)
    void callRuntimeRpc<WorkspaceCleanupPreview>(
      target,
      'workspaceCleanup.preview',
      {},
      {
        timeoutMs: EVALUATE_TIMEOUT_MS
      }
    ).then(
      (preview) => {
        if (current) {
          setPreviewState({ ownerKey, rulesKey, revision, preview })
        }
      },
      (error: unknown) => console.warn('[workspace-cleanup] preview failed', error)
    )
    return () => {
      current = false
    }
  }, [anyRuleOn, environmentId, ownerKey, rulesKey, revision, previewIsCurrent])

  const cleanUpNow = useCallback(async () => {
    setCleaningUp(true)
    try {
      await callRuntimeRpc(
        owner,
        'workspaceCleanup.runNow',
        { trigger: 'run-now' },
        {
          timeoutMs: EVALUATE_TIMEOUT_MS
        }
      )
    } catch (error) {
      toast.error(t('components.settings.workspaceCleanup.runFailed', "Couldn't run cleanup."), {
        description: errorMessage(error)
      })
    }
    // The host's finished-run event refreshes the report and the matches.
    setCleaningUp(false)
  }, [owner, t])

  const previewRules = useCallback(
    (nextRules: WorkspaceCleanupRules): Promise<WorkspaceCleanupPreview> =>
      callRuntimeRpc<WorkspaceCleanupPreview>(
        owner,
        'workspaceCleanup.preview',
        { rules: nextRules },
        { timeoutMs: EVALUATE_TIMEOUT_MS }
      ),
    [owner]
  )

  return {
    hostReport: reportState?.ownerKey === ownerKey ? reportState.hostReport : { state: 'loading' },
    preview:
      anyRuleOn && previewState?.ownerKey === ownerKey && previewState.rulesKey === rulesKey
        ? previewState.preview
        : null,
    cleaningUp,
    cleanUpNow,
    previewRules,
    adoptPreview: (savedRules, preview) =>
      setPreviewState({ ownerKey, rulesKey: JSON.stringify(savedRules), revision, preview })
  }
}
