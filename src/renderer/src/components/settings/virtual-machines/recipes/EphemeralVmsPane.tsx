import { ArrowRight, Bot, Check, Copy, Loader2, RefreshCw, Server } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store/index'
import { Button } from '../../../ui/button'
import { AgentSkillSetupPanel } from '../../../skills/setup/AgentSkillSetupPanel'
import { EphemeralVmRecipeRow } from './EphemeralVmRecipeRow'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { EPHEMERAL_VMS_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import {
  launchEnvironmentSetupAgent,
  pickEnvironmentSetupRepo
} from '@/lib/environment-setup-agent-launch'

type RecipeCatalogEntry = Awaited<
  ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog>
>[number]

// Keep the nudge short; the skill owns provider choice, setup, authentication and validation.
const AGENT_PROMPT =
  'Use the orca-per-workspace-env skill to set up a per-workspace environment for this repo.'

export function EphemeralVmsPane(): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((state) => state.openModal)
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const setupRepo = pickEnvironmentSetupRepo(repos, activeRepoId)
  const [agentLaunching, setAgentLaunching] = useState(false)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const [catalog, setCatalog] = useState<RecipeCatalogEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [promptCopied, setPromptCopied] = useState(false)
  const mountedRef = useMountedRef()
  const refreshGenerationRef = useRef(0)
  const promptResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (promptResetTimerRef.current !== null) {
        window.clearTimeout(promptResetTimerRef.current)
      }
    }
  }, [])

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
    const generation = ++refreshGenerationRef.current
    if (mountedRef.current) {
      setIsLoading(true)
    }
    try {
      const nextCatalog = await window.api.ephemeralVm.listRecipeCatalog()
      if (mountedRef.current && generation === refreshGenerationRef.current) {
        setCatalog(nextCatalog)
      }
    } catch (error) {
      if (mountedRef.current && generation === refreshGenerationRef.current) {
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
      if (mountedRef.current && generation === refreshGenerationRef.current) {
        setIsLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!window.api.plugins?.onChanged) {
      return
    }
    return window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        void refresh()
      }
    })
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
      if (!mountedRef.current) {
        return
      }
      setPromptCopied(true)
      if (promptResetTimerRef.current !== null) {
        window.clearTimeout(promptResetTimerRef.current)
      }
      promptResetTimerRef.current = window.setTimeout(() => {
        promptResetTimerRef.current = null
        setPromptCopied(false)
      }, 1500)
    } catch {
      toast.error(
        t('auto.components.settings.EphemeralVmsPane.copyError', 'Could not copy the prompt.')
      )
    }
  }

  const setUpWithAgent = (): void => {
    if (!setupRepo) {
      return
    }
    setAgentLaunching(true)
    void launchEnvironmentSetupAgent({ repoId: setupRepo.id })
      .then((launched) => {
        if (launched) {
          useAppStore.getState().recordFeatureInteraction('ephemeral-vm-setup')
        }
      })
      .catch(() => undefined)
      .then(() => {
        if (mountedRef.current) {
          setAgentLaunching(false)
        }
      })
  }

  const recipes = catalog.flatMap((entry) => entry.recipes.map((recipe) => ({ entry, recipe })))

  return (
    <div className="space-y-6" data-settings-section="ephemeral-vms">
      <AgentSkillSetupPanel
        title={t(
          'auto.components.settings.EphemeralVmsPane.cloudVmSkillTitle',
          'Cloud VM setup skill'
        )}
        description={t(
          'auto.components.settings.EphemeralVmsPane.skillDescription',
          'Sets up, builds, authenticates, and validates repo-owned environment recipes.'
        )}
        skillNames={[EPHEMERAL_VMS_SKILL_NAME]}
        installed={skillDetected}
        loading={skillLoading}
        error={activeSkillRuntime.installDisabledReason ?? skillError}
        installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
        icon={<Server className="size-5" />}
        onRecheck={refreshSkill}
        freshnessSkillName={
          activeSkillRuntime.canUseSkillFreshness ? EPHEMERAL_VMS_SKILL_NAME : undefined
        }
      />

      <div className="space-y-3 rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="text-sm font-medium">
          {t(
            'auto.components.settings.EphemeralVmsPane.whatTitle',
            'What the skill does, with you'
          )}
        </div>
        <ul className="space-y-2">
          <WhatItem
            text={t(
              'auto.components.settings.EphemeralVmsPane.whatScaffold',
              'Writes the recipe & scripts for your provider — connected over an Orca server or SSH.'
            )}
          />
          <WhatItem
            text={t(
              'auto.components.settings.EphemeralVmsPane.whatBuild',
              'Builds a reusable base image and signs your agent in.'
            )}
          />
          <WhatItem
            text={t(
              'auto.components.settings.EphemeralVmsPane.whatValidate',
              'Validates it so you can create a workspace on it.'
            )}
          />
        </ul>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          <Button
            type="button"
            size="sm"
            disabled={!setupRepo || agentLaunching}
            onClick={setUpWithAgent}
          >
            {agentLaunching ? <Loader2 className="animate-spin" /> : <Bot />}
            {t('auto.components.settings.EphemeralVmsPane.setUpWithAgent', 'Set up with an agent')}
          </Button>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {setupRepo
              ? t(
                  'auto.components.settings.EphemeralVmsPane.setUpWithAgentHint',
                  'Starts your default agent in {{repo}}. It edits orca.yaml, runs the doctors until they pass, and opens a PR.',
                  { repo: setupRepo.displayName }
                )
              : t(
                  'auto.components.settings.EphemeralVmsPane.setUpWithAgentNoRepo',
                  'Add a project first.'
                )}
          </span>
        </div>
        <div className="space-y-2 pt-1">
          <div className="text-xs text-muted-foreground">
            {t(
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
              aria-label={t('auto.components.settings.EphemeralVmsPane.copy', 'Copy')}
              onClick={() => void copyPrompt()}
            >
              {promptCopied ? (
                <>
                  <Check className="size-3" />
                  {t('auto.components.settings.EphemeralVmsPane.copied', 'Copied')}
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
              {t('auto.components.settings.EphemeralVmsPane.recipes', 'Recipes')}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                'auto.components.settings.EphemeralVmsPane.recipesHelp',
                'Recipes from orca.yaml and enabled plugins show up here, ready to launch a workspace on.'
              )}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t(
              'auto.components.settings.EphemeralVmsPane.cloudVmRefresh',
              'Refresh Cloud VM recipes'
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
                ? t('auto.components.settings.EphemeralVmsPane.checking', 'Checking recipes...')
                : t('auto.components.settings.EphemeralVmsPane.none', 'No recipes found yet.')}
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
