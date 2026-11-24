import { useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type {
  CommanderAccount,
  CommanderMemorySummary,
  CommanderMemoryIndexQuery
} from '../../../../shared/commander/memory-contract'
import { useCommanderMemoryIndex, useMemorySearch } from './use-commander-memory-index'
import { CommanderMemoryPagination } from './CommanderMemoryPagination'

type LinkPickerProps = {
  account: CommanderAccount
  pageId: string
  links: string[]
  onPick: (id: string) => void
}

function LinkPicker({ account, pageId, links, onPick }: LinkPickerProps): React.JSX.Element {
  const t = useTranslate()
  const [input, setInput] = useState('')
  const search = useMemorySearch(input)
  const filters = useMemo<CommanderMemoryIndexQuery>(
    () => ({ order: 'recent', ...(search ? { q: search } : {}) }),
    [search]
  )
  const index = useCommanderMemoryIndex(account, filters, true)
  const candidates = index.pages.filter(
    (page) => page.pageId !== pageId && !links.includes(page.pageId)
  )
  return (
    <div className="space-y-2">
      <Input
        type="search"
        maxLength={512}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        aria-label={t('commander.memory.search', 'Search memory pages')}
        placeholder={t('commander.memory.search', 'Search memory pages')}
      />
      {index.error ? (
        <div role="alert" className="text-xs text-destructive">
          {index.error}
          <Button type="button" size="xs" variant="ghost" onClick={index.refresh}>
            {t('commander.memory.retry', 'Retry')}
          </Button>
        </div>
      ) : !index.loaded ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('commander.memory.loadingPages', 'Loading pages…')}
        </p>
      ) : !candidates.length && !index.next && !index.previous ? (
        <p className="text-xs text-muted-foreground">
          {t('commander.memory.noMatches', 'No matching pages.')}
        </p>
      ) : null}
      <ul className="scrollbar-sleek max-h-60 overflow-auto">
        {candidates.map((item) => (
          <li key={item.pageId}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full justify-start whitespace-normal break-words text-left"
              onClick={() => onPick(item.pageId)}
            >
              {item.recurringQuestion ?? item.title} ·{' '}
              {item.projectId ?? t('commander.memory.account', 'Account')}
            </Button>
          </li>
        ))}
      </ul>
      <CommanderMemoryPagination {...index} />
    </div>
  )
}

export function CommanderMemoryLinks({
  account,
  links,
  pages,
  pageId,
  pending,
  onChange
}: {
  account: CommanderAccount
  links: string[]
  pages: CommanderMemorySummary[]
  pageId: string
  pending: boolean
  onChange: (value: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {links.map((id) => (
        <Button
          type="button"
          key={id}
          size="xs"
          variant="secondary"
          onClick={() => onChange(links.filter((link) => link !== id))}
        >
          {t('commander.memory.unlink', 'Remove {{title}}', {
            title: pages.find((item) => item.pageId === id)?.title ?? id
          })}
        </Button>
      ))}
      <Popover open={open && !pending} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={pending || links.length >= 128}
          >
            {t('commander.memory.link', 'Link a page')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <LinkPicker
            account={account}
            pageId={pageId}
            links={links}
            onPick={(id) => {
              onChange([...links, id])
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
