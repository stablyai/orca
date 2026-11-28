import { useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { Tag, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { readHostBots } from '@/lib/bot-catalog-snapshot'
import { useBotHostHas } from '@/lib/bot-host-status'
import {
  BOTS_TAG_EDIT_RUNTIME_CAPABILITY,
  BOTS_TAGS_RUNTIME_CAPABILITY
} from '../../../../../shared/bot-runtime-capabilities'
import type { Bot } from '../../../../../shared/bot-types'
import {
  BOT_TAG_LIMIT,
  limitBotTagDraft,
  normalizeBotTags
} from '../../../../../shared/bots/bot-tags'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

function limitDraft(
  field: HTMLInputElement,
  suffixStart = field.selectionEnd ?? field.value.length
) {
  // A pasted list restored after a failed save is limited per tag at submission.
  if (field.value.includes(',')) {
    return
  }
  const limited = limitBotTagDraft(field.value, suffixStart)
  if (limited !== field.value) {
    const caret = limited.length - (field.value.length - suffixStart)
    field.value = limited
    field.setSelectionRange(caret, caret)
  }
}

export function BotSettingsTags({
  bot,
  update
}: {
  bot: Bot
  update: (patch: BotUpdateParams['updates']) => Promise<Bot | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const supported = useBotHostHas(bot.hostId, BOTS_TAGS_RUNTIME_CAPABILITY)
  const supportsTagEdits = useBotHostHas(bot.hostId, BOTS_TAG_EDIT_RUNTIME_CAPABILITY)
  const input = useRef<HTMLInputElement>(null)
  const compositionSuffix = useRef<string | null>(null)
  const draftRevision = useRef(0)
  if (!supported) {
    return null
  }
  const tags = bot.tags ?? []
  const atLimit = tags.length >= BOT_TAG_LIMIT
  const label = t('bots.settingsView.tags.label', 'Tags')
  const limitMessage = t('bots.settingsView.tags.limit', 'Tag limit reached')
  const readTags = (): readonly string[] => {
    // A second key press can arrive before React renders the optimistic edit.
    const current = readHostBots(bot.hostId).find(({ id }) => id === bot.id) ?? bot
    return current.tags ?? []
  }
  const removeTag = (tag: string): void => {
    void update({
      tags: supportsTagEdits ? { remove: tag } : readTags().filter((value) => value !== tag)
    })
  }
  const commitDraft = (field: HTMLInputElement): void => {
    const draft = field.value
    if (!draft) {
      return
    }
    const current = readTags()
    const candidates = normalizeBotTags([...current, ...draft.split(',')], BOT_TAG_LIMIT + 1)
    if (current.length >= BOT_TAG_LIMIT && candidates.length > BOT_TAG_LIMIT) {
      toast.error(limitMessage)
      return
    }
    const revision = ++draftRevision.current
    field.value = ''
    if (candidates.length > current.length) {
      const next = candidates.slice(0, BOT_TAG_LIMIT)
      void update({ tags: supportsTagEdits ? { add: next.slice(current.length) } : next }).then(
        (saved) => {
          if (
            !saved &&
            input.current === field &&
            draftRevision.current === revision &&
            !field.value
          ) {
            field.value = draft
          }
        }
      )
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const value = event.currentTarget.value
    if (event.key === 'Backspace' && !event.repeat && !value) {
      const tag = readTags().at(-1)
      if (tag) {
        event.preventDefault()
        removeTag(tag)
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
    if (!field.readOnly && compositionSuffix.current === null && text.includes(',')) {
      event.preventDefault()
      draftRevision.current++
      const start = field.selectionStart ?? field.value.length
      const end = field.selectionEnd ?? start
      const suffixDelimiter = field.value.indexOf(',', end)
      const suffix = field.value.slice(end, suffixDelimiter === -1 ? undefined : suffixDelimiter)
      field.setRangeText(text, start, end, 'end')
      if (suffix) {
        const lastTagStart = start + text.lastIndexOf(',') + 1
        const lastTagEnd = start + text.length + suffix.length
        field.value =
          field.value.slice(0, lastTagStart) +
          limitBotTagDraft(
            field.value.slice(lastTagStart, lastTagEnd),
            start + text.length - lastTagStart
          ) +
          field.value.slice(lastTagEnd)
      }
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
                    removeTag(tag)
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
              placeholder={atLimit ? limitMessage : t('bots.settingsView.tags.add', 'Add a tag')}
              readOnly={atLimit}
              onChange={({ currentTarget }) => {
                draftRevision.current++
                if (compositionSuffix.current === null) {
                  limitDraft(currentTarget)
                }
              }}
              onPaste={onTransfer}
              onDrop={onTransfer}
              onCompositionStart={({ currentTarget }) => {
                draftRevision.current++
                compositionSuffix.current = currentTarget.value.slice(
                  currentTarget.selectionEnd ?? currentTarget.value.length
                )
              }}
              onCompositionEnd={({ currentTarget }) => {
                const suffix = compositionSuffix.current
                compositionSuffix.current = null
                const suffixStart =
                  suffix !== null && currentTarget.value.endsWith(suffix)
                    ? currentTarget.value.length - suffix.length
                    : undefined
                limitDraft(currentTarget, suffixStart)
              }}
              onBlur={(event) => {
                if (event.currentTarget === document.activeElement) {
                  return
                }
                if (compositionSuffix.current === null) {
                  commitDraft(event.currentTarget)
                }
                compositionSuffix.current = null
              }}
              onKeyDown={onKeyDown}
            />
          </div>
        }
      />
    </SettingsInsetGroup>
  )
}
