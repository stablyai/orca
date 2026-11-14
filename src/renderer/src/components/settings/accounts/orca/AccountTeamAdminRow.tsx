// Account › "Team & admin": the one desktop entry to team, billing and admin settings, which live
// in the Orca Cloud web console. It opens the console home signed in with a single-use ticket.
import { useState } from 'react'
import { ExternalLink, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ACCOUNT_TEAM_ADMIN_ANCHOR } from '@/hooks/settings-navigation-orca-cloud-sections'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'

export function AccountTeamAdminRowView({
  busy,
  onOpen
}: {
  busy: boolean
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      id={ACCOUNT_TEAM_ADMIN_ANCHOR}
      className="flex scroll-mt-4 flex-wrap items-center gap-4 border-t border-border/60 pt-5"
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <Users className="size-5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {t('settings.cloudConsole.teamAdmin.title', 'Team & admin')}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'settings.cloudConsole.teamAdmin.description',
            'Manage members, billing, single sign-on and the audit log in your browser.'
          )}
        </p>
      </div>
      {/* A plain button, no "Copy link": the page opens signed in with a single-use code. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={busy || undefined}
        onClick={busy ? undefined : onOpen}
      >
        {t('settings.cloudConsole.manageInBrowser', 'Manage in browser')}
        <ExternalLink />
      </Button>
    </div>
  )
}

/** Mount only while signed in to Orca Cloud. */
export function AccountTeamAdminRow(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <AccountTeamAdminRowView
      busy={busy}
      onOpen={() => {
        setBusy(true)
        void openCloudConsole('home').finally(() => setBusy(false))
      }}
    />
  )
}
