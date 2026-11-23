// Brand marks for Orca's own connectors, the MCP apps Add to <bot> lists and well-known tools, on the tile each brand
// is drawn on (LOGO_TILES.brand; white otherwise). GitHub keeps its monochrome mark: the connector's own icon.
import React, { type ComponentType } from 'react'
import atlassianLogo from '@/assets/connector-brands/atlassian.svg'
import cloudflareLogo from '@/assets/connector-brands/cloudflare.svg'
import context7Logo from '@/assets/connector-brands/context7.svg'
import datadogLogo from '@/assets/connector-brands/datadog.svg'
import gitlabLogo from '@/assets/connector-brands/gitlab.svg'
import googleLogo from '@/assets/connector-brands/google.svg'
import neonLogo from '@/assets/connector-brands/neon.svg'
import netlifyLogo from '@/assets/connector-brands/netlify.svg'
import notionLogo from '@/assets/connector-brands/notion.svg'
import playwrightLogo from '@/assets/connector-brands/playwright.svg'
import posthogLogo from '@/assets/connector-brands/posthog.svg'
import sentryLogo from '@/assets/connector-brands/sentry.svg'
import slackLogo from '@/assets/connector-brands/slack.svg'
import stripeLogo from '@/assets/connector-brands/stripe.svg'
import supabaseLogo from '@/assets/connector-brands/supabase.svg'
import vercelLogo from '@/assets/connector-brands/vercel.svg'
import { GitHubIcon } from '../../icons/GitHubIcon'
import { GoogleIcon } from '../../icons/GoogleIcon'
import { SlackIcon } from '../../icons/SlackIcon'
import { LinearIcon } from '../../icons/LinearIcon'
import { BotAppLogo } from './BotAppRow'
import { LOGO_TILES } from './brand-logo-tiles'

type BotAppBrand = {
  /** A bundled logo; without one, the app's own icon. */
  logo?: string
  /** A monochrome mark: drawn where there is no logo, and as BotAppBrandMark. */
  Icon?: ComponentType<{ className?: string }>
}

/** By connector id or BOT_MCP_APPS id; a new MCP app adds its logo here, and its tile to LOGO_TILES.brand. */
const BRANDS: Readonly<Record<string, BotAppBrand>> = {
  slack: { logo: slackLogo, Icon: SlackIcon },
  google: { logo: googleLogo, Icon: GoogleIcon },
  linear: { Icon: LinearIcon },
  github: { Icon: GitHubIcon },
  vercel: { logo: vercelLogo },
  sentry: { logo: sentryLogo },
  datadog: { logo: datadogLogo },
  posthog: { logo: posthogLogo },
  cloudflare: { logo: cloudflareLogo },
  supabase: { logo: supabaseLogo },
  neon: { logo: neonLogo },
  netlify: { logo: netlifyLogo },
  gitlab: { logo: gitlabLogo },
  context7: { logo: context7Logo },
  atlassian: { logo: atlassianLogo },
  notion: { logo: notionLogo },
  stripe: { logo: stripeLogo },
  playwright: { logo: playwrightLogo }
}

/** Whether `id` (a connector, BOT_MCP_APPS id or known tool) has a brand mark. */
export function hasBotAppBrand(id: string): boolean {
  return Boolean(BRANDS[id]?.logo ?? BRANDS[id]?.Icon)
}

/** A connector's black-and-white mark in the text colour, as a chat row's icon; nothing without one. */
export function BotAppBrandMark({
  id,
  className
}: {
  id: string
  className?: string
}): React.JSX.Element | null {
  const Icon = BRANDS[id]?.Icon
  return Icon ? <Icon className={className} /> : null
}

/** An app's logo tile: its brand mark on its brand's tile, else its own icon. At xs, a link row's icon,
 *  the bare mark with no tile: a monochrome mark in the text colour, so it inverts with the theme. */
export function BotAppBrandLogo({
  app,
  size = 'md'
}: {
  /** A connector, or an MCP app by its id. */
  app: { id: string; Icon?: ComponentType<{ className?: string }> }
  /** xs: a link row's icon column; sm: a chip in a list of names; md: a list row; lg: a setup dialog's heading. */
  size?: 'xs' | 'sm' | 'md' | 'lg'
}): React.JSX.Element {
  const brand = BRANDS[app.id]
  const Icon = app.Icon ?? brand?.Icon
  if (size === 'xs') {
    return brand?.logo ? (
      <img src={brand.logo} alt="" draggable={false} className="size-3.5 object-contain" />
    ) : Icon ? (
      <Icon className="size-3.5 text-foreground" />
    ) : (
      <span className="size-3.5" />
    )
  }
  return (
    <BotAppLogo
      logo={brand?.logo}
      icon={
        brand?.logo || !Icon ? undefined : (
          <Icon className={size === 'lg' ? 'size-6.5' : size === 'sm' ? 'size-3.5' : 'size-5'} />
        )
      }
      tile={LOGO_TILES.brand[app.id]}
      size={size}
    />
  )
}
