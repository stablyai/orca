import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { readThisComputerDetectedAgents } from '@/components/agent-hook-consent/agent-hook-consent-inventory'
import { Button } from '@/components/ui/button'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { useTranslate } from '@/i18n/use-translate'
import type {
  AgentHookInstallStatus,
  AgentHookTarget
} from '../../../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  isAgentHookTarget,
  readAgentHookConsent
} from '../../../../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import { formatAgentProductName } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import { onAgentHookStatusesChanged } from '@/components/agent-hook-consent/agent-hook-status-events'
import { SettingsGroupNestedRows } from '../../section-layout/SettingsGroup'

/** One row per detected agent Orca has hooks for: installed or not, with Install or Remove. */
export function AgentHookConsentRows(): React.JSX.Element | null {
  const t = useTranslate()
  // Select the stored record (a stable reference); the merged list is derived from it.
  const detectedByContext = useAppStore((state) => state.localDetectedAgentIdsByContext)
  const detected = readThisComputerDetectedAgents({
    localDetectedAgentIdsByContext: detectedByContext
  })
  const settings = useAppStore((state) => state.settings)
  const ensureNativeDetectedAgents = useAppStore((state) => state.ensureNativeDetectedAgents)
  // null until the first read lands; an unknown status never offers an action.
  const [statuses, setStatuses] = useState<AgentHookInstallStatus[] | null>(null)
  const [busy, setBusy] = useState<AgentHookTarget | null>(null)

  const refresh = useCallback(() => {
    void window.api.agentHookConsent.statuses().then(setStatuses, () => setStatuses(null))
  }, [])
  useEffect(() => {
    void ensureNativeDetectedAgents()
  }, [ensureNativeDetectedAgents])
  // Re-read disk whenever an answer lands here, on the card, or from another client.
  const consent = settings?.agentHookConsent
  useEffect(() => {
    refresh()
  }, [consent, refresh])
  useEffect(() => onAgentHookStatusesChanged(refresh), [refresh])

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
      const label = formatAgentProductName(agent)
      toast.error(
        decision === 'granted'
          ? t('agentHookConsent.failed', 'Couldn’t install hooks for {{agent}}', { agent: label })
          : t('agentHookConsent.removeFailed', 'Couldn’t remove hooks for {{agent}}', {
              agent: label
            }),
        { description: failure || undefined }
      )
    }
  }

  return (
    <SettingsGroupNestedRows>
      {agents.map((agent) => {
        const status = statuses?.find((entry) => entry.agent === agent)
        // Disk is the truth: a failed removal still shows Installed with Remove.
        const present = status?.managedHooksPresent === true
        const approved = !present && readAgentHookConsent(settings, agent) === 'granted'
        // Only Codex writes its hooks on its own next start rather than at Install.
        const pending = approved && agent === 'codex'
        // Approved counts as on: Remove declines it, which also stops the WSL relay adding hooks there.
        const installed = present || approved
        // An unreadable config is unknown, not absent: offer a re-read instead of Install.
        const unreadable = !present && status?.state === 'error'
        return (
          <div key={agent} className="flex min-h-9 items-center gap-2.5 py-1.5 text-[13px]">
            <AgentTypeIcon agentType={agent} size={14} />
            <span className="w-32 shrink-0 truncate">{formatAgentProductName(agent)}</span>
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={(unreadable ? status?.detail : status?.configPath) || undefined}
            >
              {!status
                ? t('agentHookConsent.settings.checking', 'Checking…')
                : unreadable
                  ? t('agentHookConsent.settings.unreadable', 'Couldn’t read its settings')
                  : present
                    ? t('agentHookConsent.settings.installed', 'Installed')
                    : pending
                      ? t('agentHookConsent.settings.pending', 'Added when it next starts')
                      : approved
                        ? t('agentHookConsent.settings.approved', 'Approved, not added yet')
                        : t('agentHookConsent.settings.notInstalled', 'Not installed')}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-16"
              disabled={busy !== null || !status}
              onClick={
                unreadable ? refresh : () => void change(agent, installed ? 'declined' : 'granted')
              }
            >
              {busy === agent ? (
                <Loader2 className="animate-spin motion-reduce:animate-none" />
              ) : unreadable ? (
                t('agentHookConsent.settings.retry', 'Retry')
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
