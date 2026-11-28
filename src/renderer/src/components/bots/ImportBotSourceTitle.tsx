// Import's title names where the bot comes from; with several bots found, it is the switcher between them.
import React from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { BOT_IMPORT_APP_LABELS } from '../../../../shared/bots/bot-import'
import type { ImportPick } from './ImportBotDialog'

export function importPickKey(pick: ImportPick): string {
  return `${pick.source.app}:${pick.bot.agent}`
}

function detail(pick: ImportPick): string {
  if (pick.bot.importedAs) {
    return translate('bots.import.importedAs', 'imported before as {{bot}}', {
      bot: pick.bot.importedAs.name
    })
  }
  const kind =
    pick.source.app === 'hermes'
      ? pick.bot.agent === 'default'
        ? translate('bots.import.defaultProfile', 'default profile')
        : translate('bots.import.profile', 'profile')
      : translate('bots.import.agent', 'agent')
  return translate('bots.import.rowDetail', '{{app}} {{kind}}', {
    app: BOT_IMPORT_APP_LABELS[pick.source.app],
    kind
  })
}

export function ImportBotSourceTitle({
  picks,
  picked,
  onPick
}: {
  picks: readonly ImportPick[]
  /** Null while looking, or when nothing was found. */
  picked: ImportPick | null
  onPick: (pick: ImportPick) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (!picked) {
    return <>{t('bots.import.title', 'Import from another app')}</>
  }
  const title = t('bots.import.titleFrom', 'Import from {{source}}', {
    source: BOT_IMPORT_APP_LABELS[picked.source.app]
  })
  if (picks.length < 2) {
    return <>{title}</>
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="-mx-1.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-expanded:bg-accent"
        >
          <span className="truncate">{title}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width))]"
      >
        <DropdownMenuRadioGroup
          value={importPickKey(picked)}
          onValueChange={(key) => {
            const next = picks.find((pick) => importPickKey(pick) === key)
            if (next) {
              onPick(next)
            }
          }}
        >
          {picks.map((pick) => (
            <DropdownMenuRadioItem key={importPickKey(pick)} value={importPickKey(pick)}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{pick.bot.name}</span>
                <span className="truncate text-xs text-muted-foreground">{detail(pick)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
