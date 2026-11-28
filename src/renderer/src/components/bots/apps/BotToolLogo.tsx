// A tool's or app's tile, on its own so the tool editor can show it without the connector row.
import React from 'react'
import { Wrench } from 'lucide-react'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppLogo } from './BotAppRow'
import { botAppLogoSource } from './bot-app-logo-source'

/** A tool's or app's tile: its brand or Composio logo when one is known, else the generic tool icon. */
export function BotToolLogo({
  name,
  detail,
  size = 'md'
}: {
  /** The tool's name on the bot, or an app's name or slug. */
  name: string
  /** The tool's server URL, whose host can name the app. */
  detail?: string
  /** lg: a server page's header. */
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const source = botAppLogoSource(name, detail)
  if (source?.kind === 'brand') {
    return <BotAppBrandLogo app={{ id: source.id }} size={size} />
  }
  if (source?.kind === 'composio') {
    return <BotAppLogo slug={source.slug} size={size} />
  }
  return (
    <BotAppLogo
      plain
      size={size}
      icon={<Wrench className={size === 'sm' ? 'size-3' : size === 'lg' ? 'size-5' : 'size-4'} />}
    />
  )
}
