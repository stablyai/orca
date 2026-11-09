import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { SkillCloudOwnedShare } from '../../../../shared/skill-cloud-contract'

/** Links made before the package kept one link; each stays live until stopped here. */
export function SkillSharedOlderLinks({
  share,
  olderShares,
  busy,
  onRevokeLinks
}: {
  share: SkillCloudOwnedShare
  olderShares: SkillCloudOwnedShare[]
  busy: boolean
  onRevokeLinks: (links: SkillCloudOwnedShare[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Stopping is irreversible, so each stop asks once more, like the row's own stop.
  const [confirming, setConfirming] = useState<string | null>(null)
  const stopLabel = (id: string): string =>
    confirming === id
      ? t('auto.components.settings.shareSkills.confirmStop', 'Confirm stop')
      : t('auto.components.settings.shareSkills.stopSharing', 'Stop sharing')
  const stop = (id: string, links: SkillCloudOwnedShare[]): void => {
    if (confirming !== id) {
      setConfirming(id)
      return
    }
    setConfirming(null)
    onRevokeLinks(links)
  }

  return (
    <div className="mt-2 space-y-1 rounded-md border border-border p-2">
      <p className="text-[11px] text-muted-foreground">
        {t('auto.components.skills.SkillSharedOlderLinks.title', 'Older links')}
      </p>
      <ul className="space-y-0.5">
        {olderShares.map((older) => (
          <li key={older.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{older.url}</span>
            <Button
              type="button"
              size="xs"
              variant={confirming === older.id ? 'destructive' : 'ghost'}
              disabled={busy}
              onClick={() => stop(older.id, [older])}
            >
              {stopLabel(older.id)}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        size="xs"
        variant={confirming === 'all' ? 'destructive' : 'outline'}
        disabled={busy}
        onClick={() => stop('all', [share, ...olderShares])}
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        {confirming === 'all'
          ? t('auto.components.skills.SkillSharedOlderLinks.confirmStopAll', 'Confirm stop all')
          : t('auto.components.skills.SkillSharedOlderLinks.stopAll', 'Stop all links')}
      </Button>
    </div>
  )
}
