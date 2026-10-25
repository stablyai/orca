import { useBundledSkillInstallAction } from '@/hooks/use-bundled-skill-install-action'
import { bundledSkillSetupActionLabel } from '../settings/bundled-skill-setup-copy'
import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { FeatureSetupInlineTerminal } from '../onboarding/FeatureSetupInlineTerminal'
import { buildAgentFeatureSkillInstallCommand } from '@/lib/agent-feature-install-commands'
import type { OnboardingFeatureSetupRuntimeContext } from '../onboarding/onboarding-feature-setup-runtime'
import { useCallback, useState } from 'react'
import { ArrowUpRight, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { track } from '@/lib/telemetry'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import {
  bundledSkillInstallNeedsAttention,
  useBundledSkillInstall
} from '@/hooks/use-bundled-skill-install'
import { BundledSkillInstallStatus } from '../settings/BundledSkillInstallStatus'
import {
  onboardingFeatureSetupRunTelemetry,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupSelection
} from '../onboarding/onboarding-feature-setup'
import {
  promptForSetupGuideProject,
  useSetupTargetWorktree
} from './FeatureWallSetupWorkflowActions'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'

export function BrowserAction(props: { done: boolean }): React.JSX.Element {
  const targetWorktree = useSetupTargetWorktree()
  const browserCreationEnabled = useAppStore(
    (state) =>
      getClientCreationActionPolicy(state, targetWorktree?.id ?? null)['managed-browser'].state ===
      'enabled'
  )
  const openModal = useAppStore((s) => s.openModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (s) => s.openNewBrowserTabInActiveWorkspace
  )

  const handleTryIt = useCallback(() => {
    if (!targetWorktree) {
      promptForSetupGuideProject(openModal)
      return
    }
    closeModal()
    activateAndRevealWorktree(targetWorktree.id, { providesInitialSurface: true })
    const state = useAppStore.getState()
    // Why: open the browser into the worktree's active group so it lands beside
    // the user's current work rather than spawning a detached surface.
    const groupId =
      state.activeGroupIdByWorktree[targetWorktree.id] ??
      state.groupsByWorktree[targetWorktree.id]?.[0]?.id
    if (groupId) {
      void openNewBrowserTabInActiveWorkspace(groupId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
    } else {
      toast.warning(
        translate(
          'auto.components.feature.wall.FeatureWallBrowserAction.5022c43a88',
          'Browser could not open'
        ),
        {
          description: translate(
            'auto.components.feature.wall.FeatureWallBrowserAction.c9eb68b474',
            'No workspace group is available for this worktree yet.'
          )
        }
      )
    }
  }, [closeModal, openModal, openNewBrowserTabInActiveWorkspace, targetWorktree])

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {props.done || !browserCreationEnabled ? null : (
        <Button type="button" size="sm" className="w-fit gap-2" onClick={handleTryIt}>
          <ArrowUpRight className="size-3.5" />
          {translate(
            'auto.components.feature.wall.FeatureWallBrowserAction.c9728107c5',
            'Try it out'
          )}
        </Button>
      )}
      <BrowserSkillInstallButton />
    </div>
  )
}

// Scope the shared feature setup to just browser use — the grab→agent flow only
// needs the Orca CLI and browser skill, not Computer Use or orchestration.
const BROWSER_ONLY_FEATURE_SETUP: OnboardingFeatureSetupSelection = {
  browserUse: true,
  computerUse: false,
  orchestration: false,
  linearTickets: false
}

// The grab→agent flow relies on the browser skill, so offer the same install action
// the agent skills step uses, scoped to just browser use.
function BrowserSkillInstallButton(): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [busy, setBusy] = useState(false)
  const activeRuntime = useActiveProjectSkillRuntime()
  const [wslSetup, setWslSetup] = useState<{
    command: string
    runtime: OnboardingFeatureSetupRuntimeContext
  } | null>(null)
  const legacyWsl = activeRuntime.agentRuntime?.runtime === 'wsl'
  const skillInstall = useBundledSkillInstall()
  const installSkills = skillInstall.install
  const installAction = useBundledSkillInstallAction([ORCA_CLI_SKILL_NAME], {
    enabled: !legacyWsl,
    refreshKey: skillInstall.state.kind
  })

  const handleInstall = useCallback(async () => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      const result = await runOnboardingFeatureSetup(BROWSER_ONLY_FEATURE_SETUP)
      recordFeatureInteraction('agent-browser-setup')
      // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
      if (legacyWsl) {
        const command = buildAgentFeatureSkillInstallCommand(result.skillNames)
        await window.api.ui.writeClipboardText(command)
        setWslSetup({ command, runtime: activeRuntime })
        return
      }
      const installState = await installSkills(
        result.skillNames,
        installAction.kind === 'replace' ? installAction.paths : undefined
      )
      const telemetry =
        installState &&
        onboardingFeatureSetupRunTelemetry(BROWSER_ONLY_FEATURE_SETUP, result, installState)
      if (telemetry) {
        track('onboarding_feature_setup_run', telemetry)
      }
      if (installState?.kind !== 'done' || !installState.summary.ok) {
        return
      }
      const firstWarning = result.warnings[0]
      if (firstWarning) {
        toast.warning(
          translate(
            'auto.components.feature.wall.FeatureWallBrowserAction.25dd101f15',
            'Browser setup needs attention'
          ),
          { description: firstWarning.message }
        )
      } else {
        toast.success(
          translate(
            'auto.components.feature.wall.FeatureWallBrowserAction.e02b11e6b0',
            'Browser setup ready'
          )
        )
      }
    } catch (error) {
      console.error('Browser setup failed', error)
      toast.error(
        translate(
          'auto.components.feature.wall.FeatureWallBrowserAction.78e65f19d9',
          'Browser setup failed'
        ),
        {
          description:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.feature.wall.FeatureWallBrowserAction.b7345c18db',
                  'An unexpected error occurred.'
                )
        }
      )
    } finally {
      setBusy(false)
    }
  }, [activeRuntime, busy, installAction, installSkills, legacyWsl, recordFeatureInteraction])

  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  if (wslSetup) {
    return (
      <FeatureSetupInlineTerminal
        command={wslSetup.command}
        runtimeContext={wslSetup.runtime}
        selection={BROWSER_ONLY_FEATURE_SETUP}
      />
    )
  }
  if (
    skillInstall.state.kind === 'unsupported' ||
    (!legacyWsl && installAction.kind === 'unsupported') ||
    bundledSkillInstallNeedsAttention(skillInstall.state) ||
    (!legacyWsl && installAction.kind === 'attention')
  ) {
    return (
      <BundledSkillInstallStatus
        install={skillInstall}
        unsupported={installAction.kind === 'unsupported' ? installAction.reason : undefined}
        attention={
          installAction.kind === 'attention'
            ? { retry: () => void handleInstall(), message: installAction.attentionMessage }
            : undefined
        }
        className="w-full"
      />
    )
  }

  if (!legacyWsl && installAction.kind === 'none') {
    if (skillInstall.state.kind === 'done') {
      return <BundledSkillInstallStatus install={skillInstall} />
    }
    return (
      <p className="text-xs text-muted-foreground">
        {translate('auto.components.skills.skillPlanOpCopy.installed', 'Installed')}
      </p>
    )
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-fit gap-2"
        disabled={
          (!legacyWsl && installAction.kind === 'loading') ||
          busy ||
          (legacyWsl ? Boolean(activeRuntime.installDisabledReason) : !skillInstall.ready)
        }
        onClick={() => void handleInstall()}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
        {busy
          ? translate(
              'auto.components.feature.wall.FeatureWallBrowserAction.5f97caf76b',
              'Installing…'
            )
          : installAction.kind === 'replace'
            ? translate(
                'auto.components.settings.AgentSkillSetupPanel.replaceWithOrcaCopy',
                "Replace with Orca's copy"
              )
            : installAction.kind === 'run' && installAction.changes
              ? bundledSkillSetupActionLabel(installAction.changes)
              : translate('auto.components.skills.SkillInstallDialog.39acb9e8f4', 'Install skill')}
      </Button>
      <BundledSkillInstallStatus install={skillInstall} />
    </>
  )
}
