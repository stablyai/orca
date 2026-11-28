import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type {
  AgentHookInstallStatus,
  AgentHookTarget
} from '../../../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  isAgentHookTarget,
  readAgentHookConsent
} from '../../../../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import { SettingsGroupNestedRows } from '../../section-layout/SettingsGroup'

/** One row per detected agent Orca has hooks for: installed or not, with Install or Remove. */
export function AgentHookConsentRows({
  settings
}: {
  settings: GlobalSettings
}): React.JSX.Element | null {
  const t = useTranslate()
  const detected = useAppStore((state) => state.detectedAgentIds)
  const ensureNativeDetectedAgents = useAppStore((state) => state.ensureNativeDetectedAgents)
  const [statuses, setStatuses] = useState<AgentHookInstallStatus[]>([])
  const [busy, setBusy] = useState<AgentHookTarget | null>(null)

  const refresh = useCallback(() => {
    void window.api.agentHookConsent.statuses().then(setStatuses, () => setStatuses([]))
  }, [])
  useEffect(() => {
    void ensureNativeDetectedAgents()
    refresh()
  }, [ensureNativeDetectedAgents, refresh])

  const agents = (detected ?? []).filter(isAgentHookTarget)
  if (agents.length === 0) {
    return null
  }

  const change = async (
    agent: AgentHookTarget,
    decision: 'granted' | 'declined'
  ): Promise<void> => {
    setBusy(agent)
    const failure = await decideAgentHooks(agent, decision)
    setBusy(null)
    refresh()
    if (failure !== null) {
      toast.error(
        t('agentHookConsent.failed', 'Couldn’t install hooks for {{agent}}', {
          agent: formatAgentTypeLabel(agent)
        }),
        { description: failure || undefined }
      )
    }
  }

  return (
    <SettingsGroupNestedRows>
      {agents.map((agent) => {
        const status = statuses.find((entry) => entry.agent === agent)
        const installed =
          readAgentHookConsent(settings, agent) === 'granted' &&
          status?.managedHooksPresent === true
        return (
          <div key={agent} className="flex min-h-9 items-center gap-2.5 py-1.5 text-[13px]">
            <AgentTypeIcon agentType={agent} size={14} />
            <span className="w-32 shrink-0 truncate">{formatAgentTypeLabel(agent)}</span>
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={status?.configPath || undefined}
            >
              {installed
                ? t('agentHookConsent.settings.installed', 'Installed')
                : t('agentHookConsent.settings.notInstalled', 'Not installed')}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-16"
              disabled={busy !== null}
              onClick={() => void change(agent, installed ? 'declined' : 'granted')}
            >
              {busy === agent ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : installed ? (
                t('agentHookConsent.settings.remove', 'Remove')
              ) : (
                t('agentHookConsent.install', 'Install')
              )}
            </Button>
          </div>
        )
      })}
    </SettingsGroupNestedRows>
  )
}

/** The failure detail when installing failed, '' when it failed without one, else null. */
async function decideAgentHooks(
  agent: AgentHookTarget,
  decision: 'granted' | 'declined'
): Promise<string | null> {
  try {
    const results = await window.api.agentHookConsent.decide({ agents: [agent], decision })
    const failed = results.find((status) => status.state === 'error')
    return failed ? (failed.detail ?? '') : null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
