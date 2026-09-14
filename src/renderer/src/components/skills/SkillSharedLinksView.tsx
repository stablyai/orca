import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { SkillSharedLinkRow } from './SkillSharedLinkRow'
import type { OwnedSkillShares } from './use-owned-skill-shares'

function matchesQuery(name: string, query: string): boolean {
  return !query || name.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US').trim())
}

/** The publisher's own links, listed on the page that publishes them so the
 *  record of a share lives beside the thing that made it. */
export function SkillSharedLinksView({
  query,
  shares: { shares, loading, error, busyShareId, revoke, refresh }
}: {
  query: string
  shares: OwnedSkillShares
}): React.JSX.Element {
  const visible = useMemo(
    () => shares.filter((share) => matchesQuery(share.name, query)),
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
        {translate('auto.components.skills.SkillSharedLinksView.loading', 'Loading shared links…')}
      </p>
    )
  }

  if (shares.length === 0) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.shareSkills.noActiveLinks',
          'No active links. Publish a skill bundle from Skills to create one.'
        )}
      </p>
    )
  }

  if (visible.length === 0) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {translate(
          'auto.components.skills.SkillSharedLinksView.noMatches',
          'No links match this search.'
        )}
      </p>
    )
  }

  return (
    <>
      <p className="pb-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.shareSkills.activeLinksDescription',
          'Only people with a link can open it. Unshare a link to block future inspection and installs.'
        )}
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {visible.map((share) => (
          <SkillSharedLinkRow
            key={share.id}
            share={share}
            busy={busyShareId === share.id}
            onRevoke={() => void revoke(share)}
            onDeleted={refresh}
          />
        ))}
      </ul>
    </>
  )
}
