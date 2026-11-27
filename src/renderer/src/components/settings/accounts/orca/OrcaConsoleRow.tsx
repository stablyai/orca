// Settings › Orca account › "Team & admin": opens the web console signed in with a single-use ticket.
import { useState } from 'react'
import { ExternalLink, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'

async function openConsole(t: Translate): Promise<void> {
  const openFailed = (): void => {
    toast.error(t('settings.cloudConsole.openFailed', 'Couldn’t open the browser. Try again.'))
  }
  try {
    const result = await window.api.orcaProfiles.openCloudConsole({ section: 'home' })
    if (result.status !== 'opened') {
      openFailed()
    } else if (result.ticketError) {
      toast.warning(
        t('settings.cloudConsole.signInFailed', 'Couldn’t sign you in to the console'),
        {
          description: t(
            'settings.cloudConsole.signInFailedDetail',
            'Your browser opened it anyway. Sign in there to continue.'
          )
        }
      )
    }
  } catch {
    openFailed()
  }
}

export function OrcaConsoleRow(): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border/60 pt-5">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
        <Users className="size-5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          {t('settings.cloudConsole.teamAdmin.title', 'Team & admin')}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {t('settings.cloudConsole.teamAdmin.description', 'Manage your team in your browser.')}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={busy || undefined}
        onClick={
          busy
            ? undefined
            : () => {
                setBusy(true)
                void openConsole(t).finally(() => setBusy(false))
              }
        }
      >
        {t('settings.cloudConsole.manageInBrowser', 'Manage in browser')}
        <ExternalLink />
      </Button>
    </div>
  )
}
