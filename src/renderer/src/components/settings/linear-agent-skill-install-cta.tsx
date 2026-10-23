import { bundledSkillSetupActionLabel } from './bundled-skill-setup-copy'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { WslLinearAgentSkillInstallCta } from './WslLinearAgentSkillInstallCta'
import { useCallback, useMemo } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { SkillUnsupportedStatusPill } from '../skills/SkillFreshnessStatusPill'
import { Button } from '@/components/ui/button'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useBundledSkillInstallAction } from '@/hooks/use-bundled-skill-install-action'
import {
  bundledSkillInstallNeedsAttention,
  useBundledSkillInstall
} from '@/hooks/use-bundled-skill-install'
import { LINEAR_AGENT_SKILL_NAMES, ORCA_LINEAR_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { getLinearAgentSkillUpdateTarget } from '@/lib/linear-agent-skill-update-target'
import { cn } from '@/lib/utils'
import { getLinearAgentSkillSetupInlineRuntimeCopy } from '../sidebar/linear-agent-skill-setup-copy'
import type { LinearAgentSkillPromptSettings } from '../sidebar/linear-agent-skill-runtime'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { BundledSkillInstallStatus } from './BundledSkillInstallStatus'
import { recheckSurfacesAfterAgentSkillInstall } from './agent-skill-recheck-surface-sync'
import { translate } from '@/i18n/i18n'

type LinearAgentSkillInstallCtaProps = {
  settings: LinearAgentSkillPromptSettings | null | undefined
}

// Why: the Linear task provider and the orca-linear agent skill are decoupled
// setups; this section bridges them so connecting the provider also surfaces
// the skill agents need to read and edit Linear tasks.
function BundledLinearAgentSkillInstallCta({
  settings
}: LinearAgentSkillInstallCtaProps): React.JSX.Element {
  // Why: mirror the sidebar setup prompt's runtime resolution so both surfaces
  // agree on which machine (host vs. WSL distro) is scanned and installed to.
  const remote = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  const activeRuntime = useActiveProjectSkillRuntime()
  const agentRuntime = activeRuntime.agentRuntime ?? { runtime: 'host', label: '' }
  const skill = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget: activeRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const skillName = useMemo(
    () => getLinearAgentSkillUpdateTarget(skill.skills, skill.installed).skillName,
    [skill.installed, skill.skills]
  )
  const { refresh } = skill
  const recheckAfterInstall = useCallback(
    () => recheckSurfacesAfterAgentSkillInstall(refresh),
    [refresh]
  )
  const skillInstall = useBundledSkillInstall({
    onFinished: recheckAfterInstall,
    target: activeRuntime.bundledSkillTarget
  })
  const { state, ready, install } = skillInstall
  const installing = state.kind === 'installing'
  const action = useBundledSkillInstallAction([skillName], {
    enabled: true,
    refreshKey: state.kind,
    target: activeRuntime.bundledSkillTarget
  })
  const replacePaths = action.kind === 'replace' ? action.paths : undefined
  const unsupported = action.kind === 'unsupported' ? action.reason : undefined
  const needsAttention = action.kind === 'attention'
  // Why: once installed, offer a button only when the plan would change something.
  const showInstall =
    action.kind !== 'none' &&
    !unsupported &&
    !needsAttention &&
    (!skill.installed || action.kind === 'run' || action.kind === 'unknown' || replacePaths)
  const subordinateRowClass = useIntegrationSubordinateRowClass('space-y-1.5')

  return (
    <div className={subordinateRowClass}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-foreground">
          {translate(
            'auto.components.settings.linear.agent.skill.install.cta.skillLabel',
            'Agent skill:'
          )}{' '}
          <span className="font-mono text-[11px]">{ORCA_LINEAR_SKILL_NAME}</span>
        </p>
        {unsupported ? (
          <SkillUnsupportedStatusPill reason={unsupported} />
        ) : needsAttention ? (
          <IntegrationStatusPill tone="attention">
            {translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')}
          </IntegrationStatusPill>
        ) : skill.loading ? (
          <IntegrationStatusPill tone="neutral">
            {translate(
              'auto.components.settings.linear.agent.skill.install.cta.checking',
              'Checking...'
            )}
          </IntegrationStatusPill>
        ) : skill.installed || action.kind === 'none' ? (
          <IntegrationStatusPill tone="connected">
            {translate(
              'auto.components.settings.linear.agent.skill.install.cta.installed',
              'Installed'
            )}
          </IntegrationStatusPill>
        ) : (
          <IntegrationStatusPill tone="attention">
            {translate(
              'auto.components.settings.linear.agent.skill.install.cta.notInstalled',
              'Not installed'
            )}
          </IntegrationStatusPill>
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto gap-1.5"
          onClick={() => void skill.refresh()}
          disabled={skill.loading}
        >
          <RefreshCw className={cn('size-3', skill.loading && 'animate-spin')} />
          {translate('auto.components.settings.linear.agent.skill.install.cta.recheck', 'Re-check')}
        </Button>
      </div>
      {skill.error ? <p className="text-xs text-destructive">{skill.error}</p> : null}
      {(!skill.loading || unsupported) && (
        <>
          {skill.installed ? null : (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.linear.agent.skill.install.cta.description',
                'Let agents read and edit Linear tasks. Full guided setup (connect + skill + visibility) is under Settings → Task Sources.'
              )}
            </p>
          )}
          {!showInstall ||
          state.kind === 'unsupported' ||
          bundledSkillInstallNeedsAttention(state) ? null : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-fit"
              onClick={() => void install([skillName], replacePaths)}
              disabled={installing || !ready || action.kind === 'loading'}
            >
              {installing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              {installing
                ? translate(
                    'auto.components.settings.AgentSkillSetupPanel.installing',
                    'Installing...'
                  )
                : replacePaths
                  ? translate(
                      'auto.components.settings.AgentSkillSetupPanel.replaceWithOrcaCopy',
                      "Replace with Orca's copy"
                    )
                  : action.kind === 'run' && action.changes
                    ? bundledSkillSetupActionLabel(action.changes)
                    : skill.installed
                      ? translate(
                          'auto.components.settings.AgentSkillSetupPanel.updateLabel',
                          'Update'
                        )
                      : translate(
                          'auto.components.skills.SkillInstallDialog.39acb9e8f4',
                          'Install skill'
                        )}
            </Button>
          )}
          <BundledSkillInstallStatus
            install={skillInstall}
            unsupported={unsupported}
            attention={
              needsAttention
                ? { retry: () => void install([skillName]), message: action.attentionMessage }
                : undefined
            }
            buttonSize="xs"
          />
          {remote || agentRuntime.runtime === 'wsl' ? (
            <p className="text-[11px] text-muted-foreground/70">
              {getLinearAgentSkillSetupInlineRuntimeCopy(remote, agentRuntime)}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

export function LinearAgentSkillInstallCta(
  props: LinearAgentSkillInstallCtaProps
): React.JSX.Element {
  const activeRuntime = useActiveProjectSkillRuntime()
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  if (activeRuntime.agentRuntime?.runtime === 'wsl') {
    return <WslLinearAgentSkillInstallCta {...props} runtime={activeRuntime.agentRuntime} />
  }
  return <BundledLinearAgentSkillInstallCta {...props} />
}
