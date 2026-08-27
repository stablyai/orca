import { useMemo, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { SKILL_BUNDLE_INSTALL_CAPABILITY } from '../../../../shared/skill-install-capability'
import type { SkillCloudVersion } from '../../../../shared/skill-cloud-contract'
import type {
  SkillBundleInstallPreview,
  SkillBundleInstallResult
} from '../../../../shared/skill-bundle-install-contract'
import type { SkillInstallDestination } from '../../../../shared/skill-install-contract'
import { SkillBundleInstallOutcome } from './SkillBundleInstallOutcome'
import { SkillBundleInstallReview } from './SkillBundleInstallReview'
import { SkillInstallTargetFields } from './SkillInstallTargetFields'
import { defaultSelectedSkillProviders } from './skill-install-provider-groups'
import { installSkillsActionLabel, retrySkillsActionLabel } from './skill-display-labels'
import { useSkillInstallDetectedAgents } from './use-skill-install-detected-agents'
import type { SkillInstallProviderId } from '../../../../shared/skill-install-providers'
import { skillInstallWorkspaceChoices } from './skill-install-workspace-choices'
import { useSkillInstallProgress } from './skill-install-progress-state'
import { translate } from '@/i18n/i18n'
import { checklistItemsFromVersion } from './skill-package-checklist-items'
import { summarizeSkillInstallRisk } from './skill-package-install-risk'
import { retryableSkillIds } from './skill-bundle-retry-selection'

type BundleVersion = SkillCloudVersion & {
  manifest: Extract<SkillCloudVersion['manifest'], { skills: unknown }>
}

const CONFLICT_STATES = new Set(['modified', 'unowned', 'external-link', 'name-collision'])

function sameSelection(preview: SkillBundleInstallPreview, selected: ReadonlySet<string>): boolean {
  return (
    preview.skills.length === selected.size &&
    preview.skills.every((skill) => selected.has(skill.id))
  )
}

export function SkillBundleInstallFlow(props: {
  shareId: string
  version: BundleVersion
  onClose(): void
  onBusyChange(busy: boolean): void
}): React.JSX.Element {
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeStatus = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const repos = useAppStore((state) => state.repos)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const allSkillIds = useMemo(
    () => props.version.manifest.skills.map((skill) => skill.id),
    [props.version.manifest.skills]
  )
  const [selectedSkillIds, setSelectedSkillIds] = useState(() => new Set(allSkillIds))
  const [replaceSkillIds, setReplaceSkillIds] = useState<Set<string>>(() => new Set())
  const [destinationPreview, setDestinationPreview] = useState<SkillBundleInstallPreview | null>(
    null
  )
  const [result, setResult] = useState<SkillBundleInstallResult | null>(null)
  const [environmentId, setEnvironmentId] = useState('local')
  const [scope, setScope] = useState<'global' | 'workspace'>('global')
  // Why: null means "follow detection"; storing the derived default instead
  // would freeze the picker on whichever machine was selected first.
  const [providerChoice, setProviderChoice] = useState<Set<SkillInstallProviderId> | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [executionTarget, setExecutionTarget] = useState<{ kind: 'wsl'; distro: string } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const installProgress = useSkillInstallProgress()
  const detectedAgents = useSkillInstallDetectedAgents({
    environmentId,
    wslDistro: executionTarget?.distro ?? null
  })
  const providers = providerChoice ?? defaultSelectedSkillProviders(detectedAgents)
  const riskSummary = useMemo(
    () => summarizeSkillInstallRisk(checklistItemsFromVersion(props.version), selectedSkillIds),
    [props.version, selectedSkillIds]
  )

  const workspaceChoices = useMemo(
    () => skillInstallWorkspaceChoices({ environmentId, folderWorkspaces, repos, worktreesByRepo }),
    [environmentId, folderWorkspaces, repos, worktreesByRepo]
  )
  const sshConnections = useMemo(
    () =>
      [...sshTargetLabels.entries()].map(([id, label]) => ({
        id,
        label,
        connected: sshConnectionStates.get(id)?.status === 'connected'
      })),
    [sshConnectionStates, sshTargetLabels]
  )

  const resetPreview = (): void => {
    setDestinationPreview(null)
    setReplaceSkillIds(new Set())
  }

  const destination = (): SkillInstallDestination | null => {
    const choice = workspaceChoices.find((candidate) => candidate.id === workspace)
    if (scope === 'workspace' && !choice) {
      return null
    }
    if (scope === 'workspace') {
      return choice?.kind === 'worktree'
        ? { scope: 'workspace', worktreeId: choice.id }
        : { scope: 'workspace', folderWorkspaceId: choice!.id }
    }
    return environmentId.startsWith('ssh:')
      ? {
          scope: 'global',
          executionTarget: { kind: 'ssh', connectionId: environmentId.slice('ssh:'.length) }
        }
      : { scope: 'global', ...(executionTarget ? { executionTarget } : {}) }
  }

  const install = async (
    requestedIds: ReadonlySet<string> = selectedSkillIds,
    reusePreview = true
  ): Promise<void> => {
    const target = destination()
    if (!target || requestedIds.size === 0) {
      setError(
        target
          ? translate('auto.components.skills.install.selectSkill', 'Select at least one skill.')
          : translate('auto.components.skills.install.chooseWorkspace', 'Choose a workspace.')
      )
      return
    }
    setBusy(true)
    props.onBusyChange(true)
    setError(null)
    try {
      const selectedSkills = props.version.manifest.skills
        .filter((skill) => requestedIds.has(skill.id))
        .map((skill) => ({ id: skill.id, name: skill.name, digest: skill.digest }))
      let checked =
        reusePreview && destinationPreview && sameSelection(destinationPreview, requestedIds)
          ? destinationPreview
          : null
      if (!checked) {
        const operation = await window.api.skills.previewBundleInstall({
          ...(environmentId === 'local' || environmentId.startsWith('ssh:')
            ? {}
            : { environmentId }),
          package: {
            packageId: props.version.packageId,
            versionId: props.version.versionId,
            bundleDigest: props.version.manifest.bundleDigest,
            archiveSha256: props.version.archiveSha256,
            compressedBytes: props.version.compressedBytes
          },
          selectedSkills,
          destination: target
        })
        if (operation.status === 'unsupported') {
          setError(operation.message)
          return
        }
        checked = operation.value
        setDestinationPreview(checked)
        if (checked.skills.some((skill) => CONFLICT_STATES.has(skill.currentState))) {
          return
        }
      }
      const operationId = crypto.randomUUID()
      installProgress.begin(operationId)
      const operation = await window.api.skills.installBundleShare({
        shareId: props.shareId,
        versionId: props.version.versionId,
        operationId,
        ...(environmentId === 'local' || environmentId.startsWith('ssh:') ? {} : { environmentId }),
        selectedSkillIds: [...requestedIds],
        destination: target,
        providers: [...providers],
        conflictDecisions: checked.skills
          .filter((skill) => CONFLICT_STATES.has(skill.currentState))
          .map((skill) => ({
            skillId: skill.id,
            resolution: replaceSkillIds.has(skill.id)
              ? ('replace-and-discard-local' as const)
              : ('keep-local' as const)
          }))
      })
      if (operation.status === 'unsupported') {
        setError(operation.message)
      } else if (operation.status !== 'ok') {
        setError(
          operation.status === 'reconnect-required'
            ? translate('auto.components.skills.install.reconnectBeforeInstalling', 'Reconnect your Orca account before installing.')
            : operation.message
        )
      } else {
        setResult(operation.value)
        if (
          operation.value.skills.some((skill) =>
            ['installed', 'updated', 'unchanged'].includes(skill.status)
          )
        ) {
          notifyInstalledAgentSkillsChanged()
        }
      }
    } catch (cause) {
      console.warn('[skills] bundle install failed:', cause)
      setError(translate('auto.components.skills.install.bundleVerificationFailed', 'Installation failed before Orca could verify the requested bundle.'))
    } finally {
      installProgress.finish()
      setBusy(false)
      props.onBusyChange(false)
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
      setError(translate('auto.components.skills.install.destinationAlreadyFinished', 'The destination had already finished this installation.'))
    }
  }

  const retryIds = retryableSkillIds(result)

  return (
    <>
      {result ? (
        <SkillBundleInstallOutcome result={result} />
      ) : (
        <SkillBundleInstallReview
          version={props.version}
          selectedSkillIds={selectedSkillIds}
          destinationPreview={destinationPreview}
          replaceSkillIds={replaceSkillIds}
          riskSummary={riskSummary}
          busy={busy}
          onToggleSkill={(id, selected) => {
            setSelectedSkillIds((current) => {
              const next = new Set(current)
              if (selected) {
                next.add(id)
              } else {
                next.delete(id)
              }
              return next
            })
            resetPreview()
          }}
          onToggleAll={(selected) => {
            setSelectedSkillIds(new Set(selected ? allSkillIds : []))
            resetPreview()
          }}
          onToggleReplace={(id, replace) =>
            setReplaceSkillIds((current) => {
              const next = new Set(current)
              if (replace) {
                next.add(id)
              } else {
                next.delete(id)
              }
              return next
            })
          }
        >
          <SkillInstallTargetFields
            environmentId={environmentId}
            onEnvironmentChange={(value) => {
              setEnvironmentId(value)
              resetPreview()
            }}
            scope={scope}
            onScopeChange={(value) => {
              setScope(value)
              resetPreview()
            }}
            workspace={workspace}
            onWorkspaceChange={(value) => {
              setWorkspace(value)
              resetPreview()
            }}
            executionTarget={executionTarget}
            onExecutionTargetChange={(value) => {
              setExecutionTarget(value)
              resetPreview()
            }}
            providers={providers}
            detectedAgents={detectedAgents}
            onProvidersChange={setProviderChoice}
            busy={busy}
            runtimeEnvironments={runtimeEnvironments}
            runtimeStatus={runtimeStatus}
            sshConnections={sshConnections}
            workspaceChoices={workspaceChoices}
            requiredCapability={SKILL_BUNDLE_INSTALL_CAPABILITY}
          />
        </SkillBundleInstallReview>
      )}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {installProgress.phaseLabel ? (
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {installProgress.phaseLabel}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>
          {translate('auto.components.skills.SkillBundleInstallFlow.01c5a13e01', 'Close')}
        </Button>
        {busy && installProgress.activeOperationId ? (
          <Button type="button" variant="secondary" onClick={() => void cancelInstall()}>
            {translate(
              'auto.components.skills.SkillBundleInstallFlow.01c5a13e02',
              'Cancel installation'
            )}
          </Button>
        ) : null}
        {!result || retryIds.size ? (
          <Button
            type="button"
            disabled={
              busy || (!result && (!selectedSkillIds.size || (scope === 'workspace' && !workspace)))
            }
            onClick={() => void (result ? install(retryIds, false) : install())}
            className="w-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            {busy
              ? translate('auto.components.skills.SkillBundleInstallFlow.01c5a13e03', 'Installing…')
              : result
                ? retrySkillsActionLabel(retryIds.size)
                : installSkillsActionLabel(selectedSkillIds.size)}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )
}
