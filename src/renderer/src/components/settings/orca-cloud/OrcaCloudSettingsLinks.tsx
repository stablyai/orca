import {
  Boxes,
  ChevronRight,
  CreditCard,
  LockKeyhole,
  Plug,
  SquareTerminal,
  Users
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'

type OrcaCloudLink = { pane: SettingsNavTarget; icon: LucideIcon; label: string }

/** Settings › Orca account: the Orca Cloud panes live in their own group; this points at them. */
export function OrcaCloudSettingsLinks({
  onOpen
}: {
  onOpen: (pane: SettingsNavTarget) => void
}): React.JSX.Element {
  const t = useTranslate()
  const links: OrcaCloudLink[] = [
    {
      pane: 'cloud-billing',
      icon: CreditCard,
      label: t('auto.components.billing.title', 'Plan & billing')
    },
    { pane: 'cloud-team', icon: Users, label: t('auto.components.billing.team.title', 'Team') },
    { pane: 'cloud-secrets', icon: LockKeyhole, label: t('cloudSecrets.title', 'Cloud secrets') },
    {
      pane: 'cloud-environments',
      icon: Boxes,
      label: t('settings.orcaCloud.environments.title', 'Cloud environments')
    },
    { pane: 'cloud-mcp', icon: Plug, label: t('cloudMcpSync.title', 'MCP servers') },
    {
      pane: 'cloud-local-commands',
      icon: SquareTerminal,
      label: t('localCommands.settings.title', 'Commands on this computer')
    }
  ]
  return (
    <nav
      className="space-y-3 border-t border-border/60 pt-5"
      aria-label={t('settings.groups.orcaCloud', 'Orca Cloud')}
    >
      <SettingsGroupHeader className="px-0" title={t('settings.groups.orcaCloud', 'Orca Cloud')} />
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card shadow-xs">
        {links.map(({ pane, icon: Icon, label }) => (
          <li key={pane}>
            <button
              type="button"
              onClick={() => onOpen(pane)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
            >
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
