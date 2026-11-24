import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** An agent the host lacks: says so and links to the install page Settings uses. */
export function AgentLaunchInstallPrompt({ entry }: { entry: AgentPickerEntry }) {
  const t = useTranslate()
  const homepageUrl = getAgentCatalog().find((agent) => agent.id === entry.agent)?.homepageUrl
  const local = (parseExecutionHostId(entry.rows[0]?.executionHostId)?.kind ?? 'local') === 'local'
  return (
    <div className="grid gap-2 px-2.5 py-3 text-xs text-muted-foreground">
      <span>
        {local
          ? t('agentPicker.agentNotInstalled', "{{agent}} isn't installed on this machine.", {
              agent: entry.label
            })
          : t('agentPicker.agentNotInstalledOnHost', "{{agent}} isn't installed on this host.", {
              agent: entry.label
            })}
      </span>
      {homepageUrl ? (
        <div>
          <Button asChild variant="outline" size="xs">
            <a
              href={homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={openAppHttpLinkFromAnchor}
            >
              {t('agentPicker.installAgent', 'Install {{agent}}', { agent: entry.label })}
              <ExternalLink className="size-3" />
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  )
}
