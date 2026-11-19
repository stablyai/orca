import { ExternalLink, MoreHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../../../ui/dropdown-menu'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import type { AgentCatalogRowProps } from './AgentCatalogRow'

export function AgentCatalogActionsMenu({
  label,
  homepageUrl,
  isDetected,
  isEnabled,
  isSavedDefault,
  onSetDefault
}: Pick<
  AgentCatalogRowProps,
  'label' | 'homepageUrl' | 'isDetected' | 'isEnabled' | 'isSavedDefault' | 'onSetDefault'
>): React.JSX.Element {
  const t = useTranslate()
  const menuButton = useRef<HTMLButtonElement>(null)
  const [menuPlacement, setMenuPlacement] = useState<{
    card: HTMLElement
    side: 'top' | 'bottom'
  } | null>(null)
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          const button = menuButton.current
          const list = button?.closest<HTMLElement>('[data-settings-scroll-list]')
          const card = list?.closest<HTMLElement>('[data-settings-group-card]')
          if (button && list && card && list.scrollHeight > list.clientHeight) {
            const bounds = list.getBoundingClientRect()
            const anchor = button.getBoundingClientRect()
            const above = anchor.top - Math.max(0, bounds.top)
            const below = Math.min(window.innerHeight, bounds.bottom) - anchor.bottom
            // Choose once so scrolling clips the menu instead of flipping it across its row.
            setMenuPlacement({ card, side: below >= above ? 'bottom' : 'top' })
          } else {
            setMenuPlacement(null)
          }
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={menuButton}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('settings.agents.agentActions', '{{agent}} actions', {
            agent: label
          })}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={cn('min-w-44', menuPlacement && 'max-h-none')}
        portalContainer={menuPlacement?.card}
        side={menuPlacement?.side}
        avoidCollisions={!menuPlacement}
      >
        <DropdownMenuItem
          disabled={!isSavedDefault && !(isDetected && isEnabled)}
          onSelect={() => onSetDefault(!isSavedDefault)}
        >
          {isSavedDefault
            ? t('settings.agents.clearDefault', 'Clear default agent')
            : t('auto.components.settings.AgentsPane.5f986a9b92', 'Set as default')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a
            href={homepageUrl}
            target="_blank"
            onClick={openAppHttpLinkFromAnchor}
            rel="noopener noreferrer"
          >
            {isDetected
              ? t('auto.components.settings.AgentsPane.fe4d630c94', 'Docs')
              : t('auto.components.settings.AgentsPane.f95b5c79b8', 'Install')}
            <ExternalLink className="ml-auto size-3" />
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
