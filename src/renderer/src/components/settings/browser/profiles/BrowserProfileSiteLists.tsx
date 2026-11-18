import { useState } from 'react'
import { Globe } from 'lucide-react'
import type { BrowserSessionProfile } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { BrowserProfileSiteList } from './BrowserProfileSiteList'

type SiteListProfile = Pick<BrowserSessionProfile, 'id' | 'label'>

/** One collapsed "Site list" row per browser profile; each opens that profile's editor below it. */
export function BrowserProfileSiteLists({
  profiles
}: {
  profiles: SiteListProfile[]
}): React.JSX.Element {
  const t = useTranslate()
  const [openProfileId, setOpenProfileId] = useState<string | null>(null)
  return (
    <div className="space-y-1.5 pt-3">
      <Label>{t('browser.siteList.label', 'Site list')}</Label>
      <p className="text-xs text-muted-foreground">
        {t(
          'browser.siteList.intro',
          'Optionally limit which sites a browser profile can reach. A profile with no list can open any site.'
        )}
      </p>
      {profiles.map((profile) => {
        const open = openProfileId === profile.id
        return (
          <div key={profile.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{profile.label}</span>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                aria-expanded={open}
                onClick={() => setOpenProfileId(open ? null : profile.id)}
              >
                <Globe className="size-3" />
                {open
                  ? t('browser.siteList.hide', 'Hide')
                  : t('browser.siteList.edit', 'Edit site list')}
              </Button>
            </div>
            {open ? <BrowserProfileSiteList profileId={profile.id} /> : null}
          </div>
        )
      })}
    </div>
  )
}
