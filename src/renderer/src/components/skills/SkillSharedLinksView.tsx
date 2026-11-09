import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { SkillSharedLinkRow } from './SkillSharedLinkRow'
import { skillSharedLinkGroups } from './skill-shared-link-groups'
import type { OwnedSkillShares } from './use-owned-skill-shares'

function matchesQuery(name: string, query: string): boolean {
  return !query || name.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US').trim())
}

export function SkillSharedLinksView({
  query,
  shares: { shares, loading, error, busyPackageId, revoke, revokeMany, refresh }
}: {
  query: string
  shares: OwnedSkillShares
}): React.JSX.Element {
  const t = useTranslate()
  const visible = useMemo(
    () => skillSharedLinkGroups(shares).filter(({ share }) => matchesQuery(share.name, query)),
    [query, shares]
  )

  if (error) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-destructive" role="alert">
        {error}
      </p>
    )
  }

  if (loading && shares.length === 0) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('auto.components.skills.SkillSharedLinksView.loading', 'Loading shared links…')}
      </p>
    )
  }

  if (shares.length === 0) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t(
          'auto.components.settings.shareSkills.noActiveLinks',
          'No active links. Publish a skill bundle from Skills to create one.'
        )}
      </p>
    )
  }

  if (visible.length === 0) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('auto.components.skills.SkillSharedLinksView.noMatches', 'No links match this search.')}
      </p>
    )
  }

  return (
    <>
      <p className="pb-2 text-xs text-muted-foreground">
        {t(
          'auto.components.settings.shareSkills.activeLinksStopDescription',
          'Only people with a link can open it. Stop sharing a link to block future inspection and installs.'
        )}
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {visible.map(({ share, olderShares }) => (
          <SkillSharedLinkRow
            key={share.id}
            share={share}
            olderShares={olderShares}
            busy={busyPackageId === share.packageId}
            stopsDisabled={busyPackageId !== null}
            onRevoke={() => void revoke(share)}
            onRevokeLinks={(links) => void revokeMany(links)}
            onDeleted={refresh}
          />
        ))}
      </ul>
    </>
  )
}
