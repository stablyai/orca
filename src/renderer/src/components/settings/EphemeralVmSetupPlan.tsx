import { Loader2, RefreshCw, Server } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { OrcaHooks } from '../../../../shared/types'
import type { EphemeralVmRecipeDoctorResult } from '../../../../shared/ephemeral-vm-recipes'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { RecipeDoctorDialog } from './EphemeralVmRecipeDialogs'
import { EphemeralVmRecipeRow } from './EphemeralVmRecipeRow'
import { EphemeralVmPrerequisitesStep } from './EphemeralVmPrerequisitesStep'
import { EphemeralVmScaffoldStep } from './EphemeralVmScaffoldStep'
import { type StepState } from './SetupStepBadge'
import { SetupStepCard } from './SetupStepCard'
import {
  getEphemeralVmSetupProgress,
  type EphemeralVmSetupStepId
} from './ephemeral-vm-setup-progress'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from '@/lib/agent-skill-cli-prerequisite'
import {
  EPHEMERAL_VMS_SKILL_INSTALL_COMMAND,
  EPHEMERAL_VMS_SKILL_NAME,
  EPHEMERAL_VMS_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'

type RecipeCatalogEntry = Awaited<
  ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog>
>[number]
type Recipe = NonNullable<OrcaHooks['vmRecipes']>[number]

export function EphemeralVmSetupPlan(): React.JSX.Element {
  const openModal = useAppStore((state) => state.openModal)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const [catalog, setCatalog] = useState<RecipeCatalogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [doctorOk, setDoctorOk] = useState(false)
  const [orcaCliReady, setOrcaCliReady] = useState(false)
  const [doctorResult, setDoctorResult] = useState<EphemeralVmRecipeDoctorResult | null>(null)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [doctorBusyKey, setDoctorBusyKey] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  const installCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          EPHEMERAL_VMS_SKILL_INSTALL_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : EPHEMERAL_VMS_SKILL_INSTALL_COMMAND
  const updateCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          EPHEMERAL_VMS_SKILL_UPDATE_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : EPHEMERAL_VMS_SKILL_UPDATE_COMMAND

  const {
    installed: skillDetected,
    loading: skillLoading,
    error: skillError,
    refresh: refreshSkill
  } = useInstalledAgentSkill(EPHEMERAL_VMS_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  // Why: the only prerequisite Orca owns is its own CLI on PATH; everything else in
  // step 1 is the user's cloud account and is informational, never auto-confirmed.
  useEffect(() => {
    let cancelled = false
    void window.api.cli
      .getInstallStatus()
      .then((status) => {
        if (!cancelled && mountedRef.current) {
          setOrcaCliReady(isOrcaCliAvailableOnPath(status))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [mountedRef])

  const refresh = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setIsLoading(true)
    }
    try {
      const nextCatalog = await window.api.ephemeralVm.listRecipeCatalog()
      if (!mountedRef.current) {
        return
      }
      setCatalog(nextCatalog)
      // Why: doctor is static/local/non-destructive, so running it for each recipe at
      // load gives an honest "validated" signal without any cloud call. A green doctor on
      // a real recipe is the only readiness signal Orca trusts.
      const recipes = nextCatalog.flatMap((entry) =>
        entry.recipes.map((recipe) => ({ repoId: entry.repoId, recipeId: recipe.id }))
      )
      const results = await Promise.all(
        recipes.map((r) =>
          window.api.ephemeralVm.doctor(r).then(
            (result) => result.ok,
            () => false
          )
        )
      )
      if (mountedRef.current) {
        setDoctorOk(results.some(Boolean))
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmsPane.loadError',
                'Could not load VM recipes.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runDoctor = async (entry: RecipeCatalogEntry, recipe: Recipe): Promise<void> => {
    const key = `${entry.repoId}:${recipe.id}`
    setDoctorBusyKey(key)
    try {
      const result = await window.api.ephemeralVm.doctor({
        repoId: entry.repoId,
        recipeId: recipe.id
      })
      if (mountedRef.current) {
        setDoctorResult(result)
        setDoctorOpen(true)
        setDoctorOk((prev) => prev || result.ok)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmsPane.doctorError',
                'Could not run recipe doctor.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setDoctorBusyKey(null)
      }
    }
  }

  const openWorkspaceComposerForRecipe = (repoId: string, recipeId: string): void => {
    openModal('new-workspace-composer', {
      initialRepoId: repoId,
      initialEphemeralVmRecipeId: recipeId,
      telemetrySource: 'settings'
    })
  }

  const recipes = useMemo(
    () => catalog.flatMap((entry) => entry.recipes.map((recipe) => ({ entry, recipe }))),
    [catalog]
  )

  const progress = useMemo(
    () =>
      getEphemeralVmSetupProgress({
        orcaCliReady,
        skillInstalled: skillDetected,
        recipeCount: recipes.length,
        doctorOk
      }),
    [orcaCliReady, skillDetected, recipes.length, doctorOk]
  )

  const stepState = (id: EphemeralVmSetupStepId): StepState => {
    if (progress.stepDone[id]) {
      return 'done'
    }
    return progress.firstIncompleteStepId === id ? 'in-progress' : 'pending'
  }

  return (
    <div className="space-y-6" data-settings-section="ephemeral-vms">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">
          {translate('auto.components.settings.EphemeralVmSetupPlan.title', 'Setup plan')}
        </div>
        <span className="rounded-full border border-border/60 bg-card px-2.5 py-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{progress.doneCount}</span> /{' '}
          {progress.total}{' '}
          {translate(
            'auto.components.settings.EphemeralVmSetupPlan.confirmed',
            'confirmed by Orca'
          )}
        </span>
      </div>

      <div className="space-y-2.5">
        {/* Step 1 — Prerequisites */}
        <SetupStepCard
          index={1}
          state={stepState('prerequisites')}
          title={translate(
            'auto.components.settings.EphemeralVmSetupPlan.prereqTitle',
            'Provider prerequisites'
          )}
          tag={translate(
            'auto.components.settings.EphemeralVmSetupPlan.tagYourAccount',
            'your account'
          )}
          why={translate(
            'auto.components.settings.EphemeralVmSetupPlan.prereqWhy',
            'Ephemeral VMs run on your cloud account. Orca never creates accounts, picks plans, or stores credentials.'
          )}
        >
          <EphemeralVmPrerequisitesStep orcaCliReady={orcaCliReady} />
        </SetupStepCard>

        {/* Step 2 — Install the skill */}
        <SetupStepCard
          index={2}
          state={stepState('skill')}
          title={translate(
            'auto.components.settings.EphemeralVmSetupPlan.skillTitle',
            'Install the Ephemeral VMs skill'
          )}
          tag={translate('auto.components.settings.EphemeralVmSetupPlan.tagDetected', 'detected')}
          why={translate(
            'auto.components.settings.EphemeralVmSetupPlan.skillWhy',
            'This is the engine of the whole setup. Once installed, your agent knows how to scaffold the recipe, build the VM image, sign itself in, and validate everything.'
          )}
        >
          <AgentSkillSetupPanel
            hideHeader
            variant="inline"
            title={translate(
              'auto.components.settings.EphemeralVmsPane.skillTitle',
              'Ephemeral VMs skill'
            )}
            description={translate(
              'auto.components.settings.EphemeralVmsPane.skillDescription',
              'Helps your agent author, build, authenticate, and validate repo-owned VM recipes.'
            )}
            command={installCommand}
            installedCommand={updateCommand}
            terminalTitle="Ephemeral VMs setup"
            terminalAriaLabel="Ephemeral VMs skill install terminal"
            terminalWorktreeId="settings-ephemeral-vms-skill-terminal"
            terminalShellOverride={activeSkillRuntime.terminalShellOverride}
            installed={skillDetected}
            loading={skillLoading}
            error={activeSkillRuntime.installDisabledReason ?? skillError}
            installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
            icon={<Server className="size-5" />}
            preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
            getPrerequisiteStatus={() =>
              activeSkillRuntime.agentRuntime?.runtime === 'wsl'
                ? window.api.cli.getWslInstallStatus(
                    getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
                  )
                : window.api.cli.getInstallStatus()
            }
            onBeforeOpenTerminal={async () => {
              await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
                ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
                : ensureOrcaCliAvailableForAgentSkillTerminal())
            }}
            onRecheck={refreshSkill}
          />
        </SetupStepCard>

        {/* Step 3 — Set up & build with your agent */}
        <SetupStepCard
          index={3}
          state={stepState('scaffold')}
          title={translate(
            'auto.components.settings.EphemeralVmSetupPlan.scaffoldTitle',
            'Set up & build with your agent'
          )}
          tag={translate(
            'auto.components.settings.EphemeralVmSetupPlan.tagYourAgent',
            'your agent'
          )}
          why={translate(
            'auto.components.settings.EphemeralVmSetupPlan.scaffoldWhy',
            'Open a normal workspace for this repo and ask your agent to use the skill. It does the rest — and pauses to confirm with you before anything that uses your cloud.'
          )}
        >
          <EphemeralVmScaffoldStep />
        </SetupStepCard>

        {/* Step 4 — Validate & create */}
        <SetupStepCard
          index={4}
          state={stepState('validate')}
          title={translate(
            'auto.components.settings.EphemeralVmSetupPlan.validateTitle',
            'Validate & create a workspace'
          )}
          tag={translate('auto.components.settings.EphemeralVmSetupPlan.tagDetected', 'detected')}
          why={translate(
            'auto.components.settings.EphemeralVmSetupPlan.validateWhy',
            'Doctor runs a non-destructive check (recipe parses, scripts wired). A green Doctor on a real recipe is the only "ready" signal Orca trusts. Then create your first workspace.'
          )}
          headerAction={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={translate(
                'auto.components.settings.EphemeralVmsPane.refresh',
                'Refresh ephemeral VM recipes'
              )}
              onClick={() => void refresh()}
              disabled={isLoading}
            >
              {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          }
        >
          {recipes.length === 0 ? (
            <div className="rounded-lg border border-border/50 bg-card/30 px-3 py-4 text-sm text-muted-foreground">
              {isLoading
                ? translate(
                    'auto.components.settings.EphemeralVmsPane.checking',
                    'Checking VM recipes...'
                  )
                : translate(
                    'auto.components.settings.EphemeralVmSetupPlan.noneHelp',
                    'No recipe discovered yet. Once your agent adds vmRecipes to orca.yaml, it appears here with Doctor and a "Use in workspace" button.'
                  )}
            </div>
          ) : (
            <div className="divide-y divide-border/50 rounded-lg border border-border/50 bg-card/30">
              {recipes.map(({ entry, recipe }) => (
                <EphemeralVmRecipeRow
                  key={`${entry.repoId}:${recipe.id}`}
                  entry={entry}
                  recipe={recipe}
                  doctorBusy={doctorBusyKey === `${entry.repoId}:${recipe.id}`}
                  onDoctor={() => void runDoctor(entry, recipe)}
                  onUse={() => openWorkspaceComposerForRecipe(entry.repoId, recipe.id)}
                />
              ))}
            </div>
          )}
        </SetupStepCard>
      </div>

      <RecipeDoctorDialog open={doctorOpen} result={doctorResult} onOpenChange={setDoctorOpen} />
    </div>
  )
}
