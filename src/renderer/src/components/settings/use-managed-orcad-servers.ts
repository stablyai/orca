import { useState } from 'react'
import { toast } from 'sonner'
import type { OrcadSshPendingProvisioning } from '../../../../shared/orcad-ssh-provisioning'
import { translate } from '@/i18n/i18n'
import { useManagedOrcadCatalog } from './use-managed-orcad-catalog'
import { deploySuccessMessage } from './managed-orcad-deploy-success'
import { resumeManagedOrcadProvisioning } from './managed-orcad-provisioning-resume'
import { cancelManagedOrcadStopFromSettings } from './managed-orcad-stop-cancellation'
import type {
  ManagedOrcadBusyAction,
  ManagedOrcadConfirmation,
  ManagedOrcadForceOperation,
  ManagedOrcadResumeInput
} from './managed-orcad-server-types'
export type {
  ManagedOrcadStatusEntry,
  ManagedOrcadTargetPreflightEntry,
  ManagedOrcadBusyAction,
  ManagedOrcadConfirmation,
  ManagedOrcadForceOperation,
  ManagedOrcadResumeInput
} from './managed-orcad-server-types'

export function useManagedOrcadServers(onEnvironmentsChanged: () => Promise<void> | void) {
  const {
    environments,
    targets,
    pendingMigrations,
    pendingSetups,
    statuses,
    loading,
    loadError,
    sshTargetId,
    targetPreflight,
    load,
    selectSshTarget
  } = useManagedOrcadCatalog()
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [busyAction, setBusyAction] = useState<ManagedOrcadBusyAction | null>(null)
  const [forceOperation, setForceOperation] = useState<ManagedOrcadForceOperation | null>(null)
  const [confirmation, setConfirmation] = useState<ManagedOrcadConfirmation | null>(null)

  const refreshAfterMutation = async (): Promise<void> => {
    await Promise.all([load(), onEnvironmentsChanged()])
  }

  const deploy = async (input: {
    name: string
    sshTargetId: string
    force?: boolean
  }): Promise<void> => {
    setBusyAction({ id: 'create', action: 'deploy' })
    setCreateError(null)
    try {
      const result = await window.api.runtimeEnvironments.deployOrcad(input)
      if (result.outcome === 'deferred') {
        if (result.forceable === false) {
          setCreateError(result.reason)
          return
        }
        setForceOperation({
          kind: 'create',
          name: input.name,
          sshTargetId: input.sshTargetId,
          candidateVersion: result.candidateVersion,
          reason: result.reason
        })
        return
      }
      toast.success(deploySuccessMessage(result))
      setFormOpen(false)
      setName('')
      selectSshTarget('')
      await refreshAfterMutation()
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      setBusyAction(null)
    }
  }

  const update = async (environmentId: string, force?: boolean): Promise<void> => {
    setBusyAction({ id: environmentId, action: 'update' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.updateOrcad({
        selector: environmentId,
        force
      })
      if (result.outcome === 'deferred') {
        if (result.forceable === false) {
          setRowErrors((current) => ({ ...current, [environmentId]: result.reason }))
          return
        }
        setForceOperation({
          kind: 'update',
          environmentId,
          candidateVersion: result.candidateVersion,
          reason: result.reason
        })
        return
      }
      toast.success(deploySuccessMessage(result))
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const resumeMigration = async (
    migration: ManagedOrcadResumeInput,
    force?: boolean
  ): Promise<void> => {
    setBusyAction({ id: migration.environmentId, action: 'resume' })
    clearRowError(migration.environmentId)
    try {
      const result = await window.api.runtimeEnvironments.deployOrcad({
        name: migration.name,
        sshTargetId: migration.sshTargetId,
        force
      })
      if (result.outcome === 'deferred') {
        if (result.forceable === false) {
          setRowErrors((current) => ({
            ...current,
            [migration.environmentId]: result.reason
          }))
          return
        }
        setForceOperation({
          kind: 'resume',
          ...migration,
          candidateVersion: result.candidateVersion,
          reason: result.reason
        })
        return
      }
      toast.success(deploySuccessMessage(result))
      await refreshAfterMutation()
    } catch (error) {
      setRowError(migration.environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const rollback = async (environmentId: string): Promise<void> => {
    setConfirmation(null)
    setBusyAction({ id: environmentId, action: 'rollback' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.rollbackOrcad({
        selector: environmentId
      })
      if (result.outcome !== 'rolled-back') {
        setRowErrors((current) => ({ ...current, [environmentId]: result.reason }))
        return
      }
      toast.success(
        translate(
          'auto.components.settings.ManagedOrcadServersSection.rollbackComplete',
          'Rolled back to orcad {{value0}}.',
          { value0: result.activeVersion }
        )
      )
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const recover = async (environmentId: string): Promise<void> => {
    setBusyAction({ id: environmentId, action: 'recover' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.recoverOrcad({
        selector: environmentId
      })
      if (result.outcome !== 'recovered') {
        setRowErrors((current) => ({
          ...current,
          [environmentId]:
            result.outcome === 'none'
              ? translate(
                  'auto.components.settings.ManagedOrcadServersSection.noRecovery',
                  'No interrupted activation remains on this host.'
                )
              : result.reason
        }))
        return
      }
      toast.success(
        result.activeVersion
          ? translate(
              'auto.components.settings.ManagedOrcadServersSection.recoveryComplete',
              'Recovered orcad {{value0}}.',
              { value0: result.activeVersion }
            )
          : translate(
              'auto.components.settings.ManagedOrcadServersSection.recoveryNoActive',
              'Recovered the pre-activation state.'
            )
      )
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const stopAndUnlink = async (environmentId: string): Promise<void> => {
    setConfirmation(null)
    setBusyAction({ id: environmentId, action: 'stop' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.stopOrcad({ selector: environmentId })
      if (result.outcome !== 'unlinked') {
        setRowErrors((current) => ({ ...current, [environmentId]: result.reason }))
        await load()
        return
      }
      toast.success(
        translate(
          'auto.components.settings.ManagedOrcadServersSection.stopComplete',
          'Stopped and unlinked {{value0}}.',
          { value0: result.environment.name }
        )
      )
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
      // An uncertain stop can still leave a durable cancellation/recovery transaction.
      await load()
    } finally {
      setBusyAction(null)
    }
  }

  const clearRowError = (environmentId: string): void => {
    setRowErrors((current) => {
      if (!(environmentId in current)) {
        return current
      }
      const next = { ...current }
      delete next[environmentId]
      return next
    })
  }

  const setRowError = (environmentId: string, error: unknown): void => {
    setRowErrors((current) => ({ ...current, [environmentId]: errorMessage(error) }))
  }

  return {
    busyAction,
    confirmation,
    createError,
    deploy,
    environments,
    forceOperation,
    formOpen,
    load,
    loadError,
    loading,
    name,
    pendingMigrations,
    pendingSetups,
    resumeProvisioning: (request: OrcadSshPendingProvisioning) =>
      resumeManagedOrcadProvisioning(request, {
        setBusyAction,
        clearRowError,
        setRowError,
        refreshAfterMutation
      }),
    recover,
    cancelStop: (id: string) =>
      cancelManagedOrcadStopFromSettings(id, {
        setBusyAction,
        clearRowError,
        setRowError,
        refreshAfterMutation
      }),
    resumeMigration,
    rollback,
    rowErrors,
    setConfirmation,
    setCreateError,
    setForceOperation,
    setFormOpen,
    setName,
    selectSshTarget,
    sshTargetId,
    statuses,
    stopAndUnlink,
    targets,
    targetPreflight,
    update
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
