import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { scrollSubsectionIntoView } from '../navigation/settings-navigation-foundations'
import { useSettingsContentScrollElement } from '../page/settings-content-scroll-element'
import { agentAccountsSubsectionTitleId } from './AgentAccountsSubsection'

export type AgentAccountsJumpLink = { id: string; title: React.ReactNode }

/** "This computer · Hosts · …" under the Agent accounts description, so later parts are one click
 *  away from the long provider list. Each link scrolls to its part and moves focus to the heading. */
export function AgentAccountsJumpRow({
  links
}: {
  links: readonly AgentAccountsJumpLink[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const scroller = useSettingsContentScrollElement()
  if (links.length < 2) {
    return null
  }
  const jump = (id: string): void => {
    scrollSubsectionIntoView(id, scroller)
    document.getElementById(agentAccountsSubsectionTitleId(id))?.focus({ preventScroll: true })
  }
  return (
    <nav
      aria-label={t('settings.agentAccounts.jumpLabel', 'Parts of this page')}
      className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
    >
      {links.map((link, index) => (
        <span key={link.id} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
          ) : null}
          <a
            href={`#${link.id}`}
            className="rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault()
              jump(link.id)
            }}
          >
            {link.title}
          </a>
        </span>
      ))}
    </nav>
  )
}
