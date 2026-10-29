import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/ai-vault-runtime-capabilities'
import { translate } from '@/i18n/i18n'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { useAppStore } from '@/store'
import { agentLabel } from './ai-vault-session-filters'
import {
  aiVaultSessionHostUpdateRequiredReason,
  aiVaultSessionRuntimeEnvironmentId,
  type AiVaultSessionDeleteHost
} from './ai-vault-session-deletability'

export function useAiVaultSessionDeleteHost(
  session: Pick<AiVaultSession, 'executionHostId'>
): AiVaultSessionDeleteHost {
  const label = useAppStore((s) => selectExecutionHostDisplayLabel(s, session.executionHostId))
  const environmentId = aiVaultSessionRuntimeEnvironmentId(session)
  // Subscribe to the host's verified status so an in-place host update re-enables Delete.
  const deleteSupported = useAppStore((s) => {
    if (!environmentId) {
      return true
    }
    const status = lastVerifiedRuntimeStatus(s.runtimeStatusByEnvironmentId?.get(environmentId))
    return status?.capabilities
      ? status.capabilities.includes(AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY)
      : null
  })
  return { label, deleteSupported }
}

const HOST_PROBE_FEEDBACK_DELAY_MS = 1000

// An unreachable host fails the delete itself; only a definite "no" stops before the dialog.
async function runtimeHostLacksDelete(environmentId: string, hostLabel: string): Promise<boolean> {
  // The menu has closed, so a slow host needs visible feedback before its dialog appears.
  let feedback: string | number | undefined
  const timer = setTimeout(() => {
    feedback = toast.loading(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.sessionDeleteCheckingHost',
        'Checking {{value0}}…',
        {
          value0: hostLabel
        }
      )
    )
  }, HOST_PROBE_FEEDBACK_DELAY_MS)
  try {
    return !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY
    ))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    if (feedback !== undefined) {
      toast.dismiss(feedback)
    }
  }
}

export function useAiVaultSessionDeleteAction({
  refresh,
  onDeleted
}: {
  refresh: (options: { force: boolean }) => Promise<void>
  onDeleted?: (session: AiVaultSession) => void
}): (session: AiVaultSession) => Promise<void> {
  const confirm = useConfirmationDialog()
  const pendingSessionIds = useRef(new Set<string>())

  const runDelete = useCallback(
    async (session: AiVaultSession) => {
      const environmentId = aiVaultSessionRuntimeEnvironmentId(session)
      // Fence to the pairing that listed this row (or its same-host rotation), never a re-pair elsewhere.
      const pairingRevision = environmentId
        ? resolveContinuedRuntimeEnvironmentRevision(environmentId, session.hostPairingRevision)
        : undefined
      const hostLabel = selectExecutionHostDisplayLabel(
        useAppStore.getState(),
        session.executionHostId
      )
      if (environmentId && (await runtimeHostLacksDelete(environmentId, hostLabel))) {
        toast.error(aiVaultSessionHostUpdateRequiredReason(hostLabel))
        return
      }
      const confirmed = await confirm({
        title: translate(
          'auto.components.right.sidebar.AiVaultSessionDeleteDialog.title',
          'Delete this session?'
        ),
        description: environmentId
          ? translate(
              'auto.components.right.sidebar.AiVaultSessionDeleteDialog.remoteDescription',
              '"{{value0}}" will be deleted from {{value2}}. Once deleted, it will no longer be resumable from {{value1}}\'s own command line either.',
              { value0: session.title, value1: agentLabel(session.agent), value2: hostLabel }
            )
          : translate(
              'auto.components.right.sidebar.AiVaultSessionDeleteDialog.description',
              '"{{value0}}" will be deleted. Once deleted, it will no longer be resumable from {{value1}}\'s own command line either.',
              { value0: session.title, value1: agentLabel(session.agent) }
            ),
        confirmLabel: translate(
          'auto.components.right.sidebar.AiVaultSessionDeleteDialog.confirm',
          'Delete'
        ),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      try {
        const result = await window.api.aiVault.deleteSession({
          agent: session.agent,
          sessionId: session.sessionId,
          filePath: session.filePath,
          executionHostId: session.executionHostId,
          ...(pairingRevision !== undefined
            ? { expectedEnvironmentPairingRevision: pairingRevision }
            : {})
        })
        if (result.outcome === 'rejected' && result.reason === 'host-update-required') {
          toast.error(aiVaultSessionHostUpdateRequiredReason(hostLabel))
          return
        }
        if (result.outcome !== 'deleted') {
          // Use one failure message rather than exposing raw main-side reasons.
          throw new Error(result.outcome)
        }
        onDeleted?.(session)
        toast.success(
          translate('auto.components.right.sidebar.AiVaultPanel.sessionDeleted', 'Session deleted')
        )
        // Main already invalidated its caches; this is only for immediate UX.
        void refresh({ force: true })
      } catch {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.sessionDeleteFailed',
            "Couldn't delete the session"
          )
        )
      }
    },
    [confirm, refresh, onDeleted]
  )

  return useCallback(
    async (session: AiVaultSession) => {
      // One flow per row: repeated clicks during a slow host check must not stack dialogs.
      if (pendingSessionIds.current.has(session.id)) {
        return
      }
      pendingSessionIds.current.add(session.id)
      try {
        await runDelete(session)
      } finally {
        pendingSessionIds.current.delete(session.id)
      }
    },
    [runDelete]
  )
}
