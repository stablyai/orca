// An MCP app whose vendor runs each region apart: the account's site picks the URL it is added by.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import type { BotMcpAppSite } from '../../../../../shared/bots/bot-mcp-apps'
import { BotAppStepHeader, BotAppStepHeading } from './BotAppStepParts'

export function BotAppSiteStep({
  logo,
  title,
  sites,
  onAdd,
  onBack,
  onClose
}: {
  logo: React.ReactNode
  title: string
  /** The first is the default. */
  sites: readonly BotMcpAppSite[]
  onAdd: (url: string) => void
  onBack: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '')
  const site = sites.find((entry) => entry.id === siteId) ?? sites[0]
  return (
    <>
      <BotAppStepHeader onBack={onBack} onClose={onClose} />
      <div className="px-6 pt-1 pb-6">
        <BotAppStepHeading
          logo={logo}
          title={title}
          line={t('bots.apps.mcp.site', 'Pick the site your {{app}} account is on', { app: title })}
        />
        <RadioGroup
          layout="inline"
          value={siteId}
          onValueChange={setSiteId}
          aria-label={t('bots.apps.mcp.siteLabel', 'Site')}
        >
          {sites.map((entry) => (
            <RadioGroupItem key={entry.id} value={entry.id} variant="pill">
              {entry.name}
            </RadioGroupItem>
          ))}
        </RadioGroup>
        <div className="mt-5 flex justify-end">
          <Button disabled={!site} onClick={() => site && onAdd(site.url)}>
            {t('bots.apps.mcp.add', 'Add {{app}}', { app: title })}
          </Button>
        </div>
      </div>
    </>
  )
}
