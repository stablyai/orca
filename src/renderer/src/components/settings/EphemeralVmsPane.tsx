import { ArrowRight, Check, Copy, Loader2, RefreshCw, Server } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { EphemeralVmRecipeRow } from './EphemeralVmRecipeRow'
import { translate } from '@/i18n/i18n'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
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

// Why: the pane leans on the skill, so the nudge is one line — the skill carries
// provider choice, prerequisites, the snapshot build, agent auth, and validation.
const AGENT_PROMPT =
  'Use the orca-per-workspace-env skill to set up a per-workspace environment for this repo.'

export function EphemeralVmsPane(): React.JSX.Element {
  const openModal = useAppStore((state) => state.openModal)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const [catalog, setCatalog] = useState<RecipeCatalogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [promptCopied, setPromptCopied] = useState(false)
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

  const refresh = useCallback(async (): Promise<void> => {
    if (mountedRef.current) {
      setIsLoading(true)
    }
    try {
      const nextCatalog = await window.api.ephemeralVm.listRecipeCatalog()
      if (mountedRef.current) {
        setCatalog(nextCatalog)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmsPane.loadError',
                'Could not load recipes.'
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

  const openWorkspaceComposerForRecipe = (repoId: string, recipeId: string): void => {
    openModal('new-workspace-composer', {
      initialRepoId: repoId,
      initialEphemeralVmRecipeId: recipeId,
      telemetrySource: 'settings'
    })
  }

  const copyPrompt = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(AGENT_PROMPT)
      useAppStore.getState().recordFeatureInteraction('ephemeral-vm-setup')
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 1500)
    } catch {
      toast.error(
        translate(
          'auto.components.settings.EphemeralVmsPane.copyError',
          'Could not copy the prompt.'
        )
      )
    }
  }

  const recipes = catalog.flatMap((entry) => entry.recipes.map((recipe) => ({ entry, recipe })))

  return (
    <div className="space-y-6" data-settings-section="ephemeral-vms">
      <AgentSkillSetupPanel
        title={translate(
          'auto.components.settings.EphemeralVmsPane.skillTitle',
          'Per-Workspace Environments skill'
        )}
        description={translate(
          'auto.components.settings.EphemeralVmsPane.skillDescription',
          'Sets up, builds, authenticates, and validates repo-owned environment recipes.'
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
        freshnessSkillName={
          activeSkillRuntime.agentRuntime?.runtime === 'wsl' ? undefined : EPHEMERAL_VMS_SKILL_NAME
        }
      />

      <div className="space-y-3 rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.settings.EphemeralVmsPane.whatTitle',
            'What the skill does, with you'
          )}
        </div>
        <ul className="space-y-2">
          <WhatItem
            text={translate(
              'auto.components.settings.EphemeralVmsPane.whatScaffold',
              'Writes the recipe & scripts for your provider — connected over an Orca server or SSH.'
            )}
          />
          <WhatItem
            text={translate(
              'auto.components.settings.EphemeralVmsPane.whatBuild',
              'Builds a reusable base image and signs your agent in.'
            )}
          />
          <WhatItem
            text={translate(
              'auto.components.settings.EphemeralVmsPane.whatValidate',
              'Validates it so you can create a workspace on it.'
            )}
          />
        </ul>
        <div className="space-y-2 pt-1">
          <div className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.EphemeralVmsPane.promptHint',
              'In any workspace, ask your agent:'
            )}
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {AGENT_PROMPT}
            </code>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0 gap-1.5"
              aria-label={translate('auto.components.settings.EphemeralVmsPane.copy', 'Copy')}
              onClick={() => void copyPrompt()}
            >
              {promptCopied ? (
                <>
                  <Check className="size-3" />
                  {translate('auto.components.settings.EphemeralVmsPane.copied', 'Copied')}
                </>
              ) : (
                <Copy className="size-3" />
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">
              {translate('auto.components.settings.EphemeralVmsPane.recipes', 'Recipes')}
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.EphemeralVmsPane.recipesHelp',
                'Recipes your agent adds to orca.yaml show up here, ready to launch a workspace on.'
              )}
            </p>
          </div>
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
        </div>

        <div className="rounded-lg border border-border/50 bg-card/30">
          {recipes.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">
              {isLoading
                ? translate(
                    'auto.components.settings.EphemeralVmsPane.checking',
                    'Checking recipes...'
                  )
                : translate(
                    'auto.components.settings.EphemeralVmsPane.none',
                    'No recipes found yet.'
                  )}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {recipes.map(({ entry, recipe }) => (
                <EphemeralVmRecipeRow
                  key={`${entry.repoId}:${recipe.id}`}
                  entry={entry}
                  recipe={recipe}
                  onUse={() => openWorkspaceComposerForRecipe(entry.repoId, recipe.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function WhatItem({ text }: { text: string }): React.JSX.Element {
  return (
    <li className="flex items-start gap-2.5 text-sm text-muted-foreground">
      <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{text}</span>
    </li>
  )
}
