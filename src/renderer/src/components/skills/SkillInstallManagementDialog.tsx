import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import type {
  ManagedSkillInstall,
  SkillInstallResult
} from '../../../../shared/skill-install-contract'
import type { SkillBundleInstallResult } from '../../../../shared/skill-bundle-install-contract'
import type { SkillCloudPackageDetails } from '../../../../shared/skill-cloud-contract'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { skillInstallManagementCopy } from './skill-install-management-copy'
import { useSkillInstallProgress } from './skill-install-progress-state'
import { summarizeManagedSkillRemoval } from './skill-managed-removal-summary'
import {
  groupManagedSkillInstalls,
  type SkillManagedInstallGroup
} from './skill-managed-install-groups'
import { translate } from '@/i18n/i18n'
import { SkillInstallManagementDialogContent } from './SkillInstallManagementDialogContent'

export function SkillInstallManagementDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const copy = skillInstallManagementCopy()
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const [environmentId, setEnvironmentId] = useState('local')
  const [installs, setInstalls] = useState<ManagedSkillInstall[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [details, setDetails] = useState<SkillCloudPackageDetails | null>(null)
  const [versionId, setVersionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [result, setResult] = useState<SkillInstallResult | null>(null)
  const [bundleResult, setBundleResult] = useState<SkillBundleInstallResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const installProgress = useSkillInstallProgress()
  const loadGeneration = useRef(0)
  const detailGeneration = useRef(0)

  const groups = useMemo(() => groupManagedSkillInstalls(installs), [installs])
  const selected = useMemo(
    () => groups.find((group) => group.key === selectedKey) ?? null,
    [groups, selectedKey]
  )
  const selectedInstall = selected?.installs[0] ?? null

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    detailGeneration.current += 1
    if (!open) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const operation = await window.api.skills.listManagedInstalls(
        environmentId === 'local' ? undefined : environmentId
      )
      if (generation !== loadGeneration.current) {
        return
      }
      if (operation.status !== 'ok') {
        setError(operation.message)
        return
      }
      setInstalls(operation.value)
      setSelectedKey('')
      setDetails(null)
      setNotice(null)
    } catch (cause) {
      if (generation !== loadGeneration.current) {
        return
      }
      console.warn('[skills] managed install listing failed:', cause)
      setError(
        translate(
          'auto.components.skills.install.inspectManagedFailed',
          'Orca could not inspect managed installs on this machine.'
        )
      )
    } finally {
      if (generation === loadGeneration.current) {
        setBusy(false)
      }
    }
  }, [environmentId, open])

  useEffect(() => {
    void load()
  }, [load])

  const selectInstall = async (group: SkillManagedInstallGroup): Promise<void> => {
    const generation = ++detailGeneration.current
    setSelectedKey(group.key)
    setDetails(null)
    setBusy(true)
    setError(null)
    setNotice(null)
    setResult(null)
    setBundleResult(null)
    setConfirmRemove(false)
    try {
      const operation = await window.api.skills.getPackage(group.packageId)
      if (generation !== detailGeneration.current) {
        return
      }
      if (operation.status !== 'ok') {
        setError(
          operation.status === 'reconnect-required'
            ? translate(
                'auto.components.skills.install.reconnectForVersionHistory',
                'Reconnect your Orca account to load version history.'
              )
            : operation.message
        )
        return
      }
      setDetails(operation.value)
      setVersionId(operation.value.versions[0]?.versionId ?? group.versionId)
    } catch (cause) {
      if (generation !== detailGeneration.current) {
        return
      }
      console.warn('[skills] package history failed:', cause)
      setError(
        translate(
          'auto.components.skills.install.versionHistoryUnavailable',
          'Version history is unavailable for this skill.'
        )
      )
    } finally {
      if (generation === detailGeneration.current) {
        setBusy(false)
      }
    }
  }

  const collapse = (): void => {
    detailGeneration.current += 1
    setSelectedKey('')
    setDetails(null)
    setResult(null)
    setBundleResult(null)
    setConfirmRemove(false)
  }

  const installVersion = async (discardLocal = false): Promise<void> => {
    if (!selected || !selectedInstall || !versionId) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    const operationId = crypto.randomUUID()
    installProgress.begin(operationId)
    try {
      const version = details?.versions.find((candidate) => candidate.versionId === versionId)
      const bundleManifest =
        version?.manifest && 'skills' in version.manifest ? version.manifest : null
      if (bundleManifest) {
        const installedNames = new Set(selected.installs.map((install) => install.name))
        const selectedSkills = bundleManifest.skills.filter((skill) =>
          installedNames.has(skill.name)
        )
        if (selectedSkills.length === 0) {
          setError(
            translate(
              'auto.components.skills.install.bundleSkillsMissing',
              'This version does not contain any of the installed bundle skills.'
            )
          )
          return
        }
        const operation = await window.api.skills.installBundlePackageVersion({
          packageId: selected.packageId,
          versionId,
          operationId,
          ...(environmentId === 'local' || environmentId.startsWith('ssh:')
            ? {}
            : { environmentId }),
          selectedSkillIds: selectedSkills.map((skill) => skill.id),
          ...(selectedInstall.providers ? { providers: selectedInstall.providers } : {}),
          destination: selected.destination,
          ...(discardLocal
            ? {
                conflictDecisions: selectedSkills.map((skill) => ({
                  skillId: skill.id,
                  resolution: 'replace-and-discard-local' as const
                }))
              }
            : {})
        })
        if (operation.status !== 'ok') {
          setError(
            operation.status === 'reconnect-required'
              ? translate(
                  'auto.components.skills.install.reconnectBeforeVersionChange',
                  'Reconnect your Orca account before changing versions.'
                )
              : operation.message
          )
          return
        }
        setBundleResult(operation.value)
        if (!['failed', 'cancelled'].includes(operation.value.status)) {
          notifyInstalledAgentSkillsChanged()
          if (operation.value.status === 'complete') {
            await load()
          }
        }
        return
      }
      const operation = await window.api.skills.installPackageVersion({
        packageId: selected.packageId,
        versionId,
        operationId,
        ...(environmentId === 'local' || environmentId.startsWith('ssh:') ? {} : { environmentId }),
        destination: selected.destination,
        ...(selectedInstall.providers ? { providers: selectedInstall.providers } : {}),
        ...(discardLocal ? { conflictResolution: 'replace-and-discard-local' } : {})
      })
      if (operation.status !== 'ok') {
        setError(
          operation.status === 'reconnect-required'
            ? translate(
                'auto.components.skills.install.reconnectBeforeVersionChange',
                'Reconnect your Orca account before changing versions.'
              )
            : operation.message
        )
        return
      }
      setResult(operation.value)
      if (!['conflict', 'failed', 'cancelled'].includes(operation.value.status)) {
        notifyInstalledAgentSkillsChanged()
        if (operation.value.status !== 'partial') {
          await load()
        }
      }
    } catch (cause) {
      console.warn('[skills] version installation failed:', cause)
      setError(
        translate(
          'auto.components.skills.install.versionVerificationFailed',
          'Orca could not verify the requested version.'
        )
      )
    } finally {
      installProgress.finish()
      setBusy(false)
    }
  }

  const cancelInstall = async (): Promise<void> => {
    if (!installProgress.activeOperationId) {
      return
    }
    const cancelled = await window.api.skills.cancelInstall({
      operationId: installProgress.activeOperationId,
      ...(environmentId === 'local' || environmentId.startsWith('ssh:') ? {} : { environmentId })
    })
    if (!cancelled.cancelled) {
      setError(
        translate(
          'auto.components.skills.install.destinationAlreadyFinished',
          'The destination had already finished this installation.'
        )
      )
    }
  }

  const remove = async (discardLocal = false): Promise<void> => {
    if (!selected) {
      return
    }
    if (!confirmRemove && !discardLocal) {
      setConfirmRemove(true)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const targets = selected.installs
      const operations = await Promise.all(
        targets.map((install) =>
          window.api.skills.removeInstall({
            ...(environmentId === 'local' || environmentId.startsWith('ssh:')
              ? {}
              : { environmentId }),
            name: install.name,
            destination: install.destination,
            ...(discardLocal ? { conflictResolution: 'replace-and-discard-local' as const } : {})
          })
        )
      )
      const unsupported = operations.find((operation) => operation.status !== 'ok')
      if (unsupported?.status === 'unsupported') {
        setError(unsupported.message)
        return
      }
      const summary = summarizeManagedSkillRemoval(operations, selected.installs.length)
      setResult(summary.lastResult)
      setNotice(summary.notice)
      if (summary.removed > 0) {
        notifyInstalledAgentSkillsChanged()
      }
      if (summary.complete) {
        await load()
      }
    } catch (cause) {
      console.warn('[skills] managed removal failed:', cause)
      setError(
        translate(
          'auto.components.skills.install.removeFailed',
          'Orca could not safely remove this skill.'
        )
      )
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    loadGeneration.current += 1
    detailGeneration.current += 1
    setSelectedKey('')
    setDetails(null)
    setError(null)
    setNotice(null)
    setResult(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && close()}>
      <SkillInstallManagementDialogContent
        bundleResult={bundleResult}
        busy={busy}
        confirmRemove={confirmRemove}
        copy={copy}
        details={details}
        environmentId={environmentId}
        error={error}
        groups={groups}
        installs={installs}
        installActive={Boolean(installProgress.activeOperationId)}
        notice={notice}
        progressLabel={installProgress.phaseLabel}
        result={result}
        runtimeEnvironments={runtimeEnvironments}
        selectedKey={selectedKey}
        sshConnectionStates={sshConnectionStates}
        sshTargetLabels={sshTargetLabels}
        versionId={versionId}
        onCancelInstall={() => void cancelInstall()}
        onClose={close}
        onEnvironmentChange={setEnvironmentId}
        onInstall={(discardLocal) => void installVersion(discardLocal)}
        onOpenChange={(group, next) => (next ? void selectInstall(group) : collapse())}
        onRemove={(discardLocal) => void remove(discardLocal)}
        onSendToMachine={(shareId) => {
          close()
          useAppStore.getState().openSkillShare(shareId)
        }}
        onVersionChange={setVersionId}
      />
    </Dialog>
  )
}
