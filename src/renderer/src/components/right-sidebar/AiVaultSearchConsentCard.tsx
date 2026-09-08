import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'

/**
 * Consent, not an announcement: transcript search reads every conversation on
 * this computer, so the card states the cost and waits for a choice.
 */
export function AiVaultSearchConsentCard({
  enabling,
  onEnable,
  onDismiss
}: {
  enabling: boolean
  onEnable: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <Card className="mt-2 gap-2 rounded-md border-sidebar-border bg-muted/40 px-2.5 py-2 shadow-none">
      <div className="text-xs font-semibold text-foreground">
        {translate(
          'auto.components.right.sidebar.AiVaultSearchConsentCard.title',
          'Search inside conversations'
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.AiVaultSearchConsentCard.body',
          'Builds a local index of your agent transcripts on this computer. Large histories can take several minutes and use several GB of disk.'
        )}
      </p>
      <div className="flex items-center gap-1.5">
        <Button type="button" size="xs" onClick={onEnable} disabled={enabling}>
          {translate('auto.components.right.sidebar.AiVaultSearchConsentCard.enable', 'Enable')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onDismiss}
          className="text-muted-foreground"
        >
          {translate('auto.components.right.sidebar.AiVaultSearchConsentCard.notNow', 'Not now')}
        </Button>
      </div>
    </Card>
  )
}

/** Shown after "Not now", only while the user is actually typing a query. */
export function AiVaultSearchTitlesOnlyNotice({
  onReopen
}: {
  onReopen: () => void
}): React.JSX.Element {
  return (
    <div className="mt-1.5 text-xs text-muted-foreground">
      {translate(
        'auto.components.right.sidebar.AiVaultSearchConsentCard.titlesOnly',
        'Titles only · '
      )}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={onReopen}
      >
        {translate(
          'auto.components.right.sidebar.AiVaultSearchConsentCard.title',
          'Search inside conversations'
        )}
      </button>
    </div>
  )
}
