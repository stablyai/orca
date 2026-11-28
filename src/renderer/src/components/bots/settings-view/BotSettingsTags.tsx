import { useEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
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
  planBotTagAdds
} from '../../../../../shared/bots/bot-tags'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

type TagDraftSelection = {
  value: string
  start: number
  end: number
  direction: HTMLInputElement['selectionDirection']
}

function readDraftSelection(field: HTMLInputElement): TagDraftSelection {
  return {
    value: field.value,
    start: field.selectionStart ?? field.value.length,
    end: field.selectionEnd ?? field.value.length,
    direction: field.selectionDirection
  }
}

function limitDraft(
  field: HTMLInputElement,
  previous: TagDraftSelection,
  suffixStart = field.selectionEnd ?? field.value.length
): boolean {
  const editStart = Math.min(previous.start, suffixStart)
  const limited = limitBotTagDraft(field.value, editStart, suffixStart)
  if (limited === null) {
    field.value = previous.value
    field.setSelectionRange(previous.start, previous.end, previous.direction ?? undefined)
    return false
  }
  if (limited !== field.value) {
    const caret = limited.length - (field.value.length - suffixStart)
    field.value = limited
    field.setSelectionRange(caret, caret)
  }
  return true
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
  const beforeEdit = useRef<TagDraftSelection | null>(null)
  const compositionDraft = useRef<TagDraftSelection | null>(null)
  const draftRevision = useRef(0)
  useEffect(() => {
    const field = input.current
    if (!supported || !field) {
      return
    }
    // Native beforeinput captures deletions before the browser collapses the selection.
    const captureEdit = (): void => {
      beforeEdit.current = readDraftSelection(field)
    }
    field.addEventListener('beforeinput', captureEdit)
    return () => {
      field.removeEventListener('beforeinput', captureEdit)
      beforeEdit.current = null
    }
  }, [supported])
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
    const next = planBotTagAdds(current, draft.split(','))
    if (!next) {
      toast.error(limitMessage)
      return
    }
    const revision = ++draftRevision.current
    field.value = ''
    if (next.length > current.length) {
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
    if (!field.readOnly && compositionDraft.current === null && text.includes(',')) {
      event.preventDefault()
      draftRevision.current++
      const previous = readDraftSelection(field)
      field.setRangeText(text, previous.start, previous.end, 'end')
      const suffixStart = field.selectionEnd ?? field.value.length
      if (
        suffixStart < field.value.length &&
        field.value[suffixStart] !== ',' &&
        !limitDraft(field, previous, suffixStart)
      ) {
        return
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
                const previous = beforeEdit.current
                beforeEdit.current = null
                if (compositionDraft.current === null && previous) {
                  limitDraft(currentTarget, previous)
                }
              }}
              onPaste={onTransfer}
              onDrop={onTransfer}
              onCompositionStart={({ currentTarget }) => {
                draftRevision.current++
                compositionDraft.current = readDraftSelection(currentTarget)
              }}
              onCompositionEnd={({ currentTarget }) => {
                const previous = compositionDraft.current
                compositionDraft.current = null
                if (!previous) {
                  return
                }
                const suffix = previous.value.slice(previous.end)
                const suffixStart = currentTarget.value.endsWith(suffix)
                  ? currentTarget.value.length - suffix.length
                  : undefined
                limitDraft(currentTarget, previous, suffixStart)
              }}
              onBlur={(event) => {
                if (event.currentTarget === document.activeElement) {
                  return
                }
                if (compositionDraft.current === null) {
                  commitDraft(event.currentTarget)
                }
                compositionDraft.current = null
              }}
              onKeyDown={onKeyDown}
            />
          </div>
        }
      />
    </SettingsInsetGroup>
  )
}
