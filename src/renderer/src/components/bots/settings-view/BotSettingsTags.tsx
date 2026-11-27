import { useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Tag, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { readHostBots } from '@/lib/bot-catalog-snapshot'
import { useBotHostHas } from '@/lib/bot-host-status'
import { BOTS_TAGS_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import type { Bot } from '../../../../../shared/bot-types'
import {
  BOT_TAG_LIMIT,
  normalizeBotTags,
  truncateBotTag
} from '../../../../../shared/bots/bot-tags'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

export function BotSettingsTags({
  bot,
  update
}: {
  bot: Bot
  update: (patch: { tags: string[] }) => Promise<Bot | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const supported = useBotHostHas(bot.hostId, BOTS_TAGS_RUNTIME_CAPABILITY)
  const input = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  if (!supported) {
    return null
  }
  const tags = bot.tags ?? []
  const atLimit = tags.length >= BOT_TAG_LIMIT
  const label = t('bots.settingsView.tags.label', 'Tags')
  const readTags = (): readonly string[] => {
    // A second key press can arrive before React renders the optimistic edit.
    const current = readHostBots(bot.hostId).find(({ id }) => id === bot.id) ?? bot
    return current.tags ?? []
  }
  const commitDraft = (field: HTMLInputElement): void => {
    if (!field.value) {
      return
    }
    const current = readTags()
    const next = normalizeBotTags([...current, ...field.value.split(',')])
    field.value = ''
    if (next.length > current.length) {
      void update({ tags: next })
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const value = event.currentTarget.value
    if (event.key === 'Backspace' && !event.repeat && !value) {
      const current = readTags()
      if (current.length > 0) {
        event.preventDefault()
        void update({ tags: current.slice(0, -1) })
      }
    } else if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commitDraft(event.currentTarget)
    }
  }
  const onTransfer = (
    event: ClipboardEvent<HTMLInputElement> | DragEvent<HTMLInputElement>
  ): void => {
    const field = event.currentTarget
    const text = ('clipboardData' in event ? event.clipboardData : event.dataTransfer).getData(
      'text'
    )
    if (!field.readOnly && !composing.current && text.includes(',')) {
      event.preventDefault()
      field.setRangeText(text)
      commitDraft(field)
    }
  }
  return (
    <SettingsInsetGroup>
      <SettingsInsetRow
        icon={<Tag />}
        title={label}
        endClassName="min-w-0 flex-[3]"
        end={
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="max-w-full">
                <span className="truncate" title={tag}>
                  {tag}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('bots.settingsView.tags.remove', 'Remove tag {{tag}}', { tag })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void update({ tags: readTags().filter((value) => value !== tag) })
                    input.current?.focus()
                  }}
                >
                  <X className="size-3" />
                </Button>
              </Badge>
            ))}
            <Input
              ref={input}
              density="compact"
              className="w-24 flex-1 basis-24"
              aria-label={label}
              placeholder={
                atLimit
                  ? t('bots.settingsView.tags.limit', 'Tag limit reached')
                  : t('bots.settingsView.tags.add', 'Add a tag')
              }
              readOnly={atLimit}
              onChange={({ currentTarget }) => {
                if (!composing.current) {
                  currentTarget.value = truncateBotTag(currentTarget.value)
                }
              }}
              onPaste={onTransfer}
              onDrop={onTransfer}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={({ currentTarget }) => {
                composing.current = false
                currentTarget.value = truncateBotTag(currentTarget.value)
              }}
              onBlur={(event) => {
                if (event.currentTarget === document.activeElement) {
                  return
                }
                if (!composing.current) {
                  commitDraft(event.currentTarget)
                }
                composing.current = false
              }}
              onKeyDown={onKeyDown}
            />
          </div>
        }
      />
    </SettingsInsetGroup>
  )
}
