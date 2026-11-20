import { memo, useContext, useEffect, useRef, useState } from 'react'
import { ChevronRight, Package, RotateCcw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { SkillSourceKind } from '../../../../../../shared/skills/discovery/skills'
import {
  NativeChatMentionOption,
  NativeChatUnavailableMentions,
  nativeChatMentionEmptyText
} from '../../NativeChatMentionOption'
import { PickerGroupHeading } from '../../NativeChatPickerGroupHeading'
import { NativeChatRoomContext } from '../../native-chat-room-context'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { NativeChatMentionFiles } from './use-native-chat-mention-files'
import { nativeChatMentionValue } from '../native-chat-composer-types'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { PickerListbox, PickerOptionButton, PickerStatus } from './NativeChatPickerParts'
import { NativeChatMentionChatList } from './NativeChatMentionChatList'
import { cn } from '@/lib/class-names'
import { localizeSlashCommandDescription } from './native-chat-slash-command-descriptions'
import { nativeChatPickerEmptyText } from './native-chat-picker-empty-text'

export const NativeChatPickerMenu = memo(function NativeChatPickerMenu({
  autocomplete,
  activeIndex,
  listboxId,
  onChoose,
  onRetry
}: {
  autocomplete: Extract<ComposerAutocomplete, { mode: 'slash' }>
  activeIndex: number
  listboxId: string
  onChoose: (item: NativeChatPickerItem) => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  const commands = autocomplete.items.filter(
    (item): item is Extract<NativeChatPickerItem, { kind: 'command' }> => item.kind === 'command'
  )
  const skills = autocomplete.items.filter(
    (item): item is Extract<NativeChatPickerItem, { kind: 'skill' }> => item.kind === 'skill'
  )

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, autocomplete.items])

  const hasSkillStatus =
    autocomplete.skillStatus === 'loading' || autocomplete.skillStatus === 'error'
  const showCommandsHeading = autocomplete.grouped && commands.length > 0
  const showSkillsHeading = autocomplete.grouped && (skills.length > 0 || hasSkillStatus)
  const noMatches =
    autocomplete.skillStatus === 'ready' && commands.length === 0 && skills.length === 0
  const checkingSkills = noMatches && autocomplete.skillsChecking && autocomplete.skillsEnabled
  const emptyText = noMatches ? nativeChatPickerEmptyText(autocomplete, t, checkingSkills) : null
  const collision = commands.find((item) => item.skillCollision)
  const duplicate = skills.find((item) => item.sources.length > 1)
  // One sentence for the line and the screen reader, so the two never disagree.
  const skillErrorText =
    autocomplete.skillErrorKind === 'unavailable'
      ? t(
          'components.native-chat.composer.skillsUnavailableHost',
          "Skills can't be listed in SSH chats"
        )
      : t('components.native-chat.composer.skillsLoadFailed', "Couldn't load skills")

  let optionIndex = 0
  return (
    <PickerListbox id={listboxId}>
      {showCommandsHeading ? <PickerGroupHeading kind="commands" /> : null}
      {commands.map((item) => {
        const index = optionIndex++
        return (
          <PickerOption
            key={item.id}
            item={item}
            index={index}
            activeIndex={activeIndex}
            listboxId={listboxId}
            activeItemRef={activeItemRef}
            onChoose={onChoose}
          />
        )
      })}
      {showSkillsHeading ? <PickerGroupHeading kind="skills" /> : null}
      {autocomplete.skillStatus === 'loading' ? (
        <PickerStatus busy>
          {t('components.native-chat.composer.loadingSkills', 'Loading skills...')}
        </PickerStatus>
      ) : null}
      {autocomplete.skillStatus === 'error' ? (
        <PickerStatus>
          <span className="min-w-0 flex-1">{skillErrorText}</span>
          {autocomplete.skillErrorKind !== 'unavailable' ? (
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onRetry}
              className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <RotateCcw className="size-3" />
              {t('components.native-chat.composer.retrySkills', 'Retry')}
            </button>
          ) : null}
        </PickerStatus>
      ) : null}
      {skills.map((item) => {
        const index = optionIndex++
        return (
          <PickerOption
            key={item.id}
            item={item}
            index={index}
            activeIndex={activeIndex}
            listboxId={listboxId}
            activeItemRef={activeItemRef}
            onChoose={onChoose}
          />
        )
      })}
      {noMatches ? <PickerStatus busy={checkingSkills}>{emptyText}</PickerStatus> : null}
      <div aria-live="polite" className="sr-only">
        {autocomplete.skillStatus === 'loading'
          ? t('components.native-chat.composer.loadingSkills', 'Loading skills...')
          : autocomplete.skillStatus === 'error'
            ? skillErrorText
            : emptyText
              ? emptyText
              : autocomplete.skillsEnabled
                ? [
                    t('components.native-chat.composer.skillsLoaded', 'Skills loaded'),
                    collision
                      ? getPickerAnnotation(collision, t)
                      : duplicate
                        ? getPickerAnnotation(duplicate, t)
                        : null
                  ]
                    .filter(Boolean)
                    .join('. ')
                : ''}
      </div>
    </PickerListbox>
  )
})

function PickerOption({
  item,
  index,
  activeIndex,
  listboxId,
  activeItemRef,
  onChoose
}: {
  item: NativeChatPickerItem
  index: number
  activeIndex: number
  listboxId: string
  activeItemRef: React.MutableRefObject<HTMLButtonElement | null>
  onChoose: (item: NativeChatPickerItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const annotation = getPickerAnnotation(item, t)
  const description =
    item.kind === 'command'
      ? localizeSlashCommandDescription(item.name, item.description)
      : item.description
  return (
    <PickerOptionButton
      id={`${listboxId}-option-${index}`}
      selected={index === activeIndex}
      activeItemRef={activeItemRef}
      onChoose={() => onChoose(item)}
    >
      {item.kind === 'skill' ? (
        <Package className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate font-mono text-chat-code font-medium">
            {item.token}
          </span>
          {item.argumentHint ? (
            <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
              {item.argumentHint}
            </span>
          ) : null}
        </span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
        {annotation ? (
          <span className="block break-all text-xs text-muted-foreground">{annotation}</span>
        ) : null}
      </span>
      {item.kind === 'skill' ? (
        <span className="shrink-0 pt-0.5 text-2xs text-muted-foreground">
          {scopeLabel(item.sources[0]?.sourceKind, t)}
        </span>
      ) : null}
    </PickerOptionButton>
  )
}

function getPickerAnnotation(item: NativeChatPickerItem, t: Translate = translate): string | null {
  if (item.kind === 'skill' && item.location) {
    return item.location
  }
  if (item.kind === 'command' && item.skillCollision) {
    return t(
      'components.native-chat.composer.skillCommandCollision',
      'Also a skill name - agent decides'
    )
  }
  if (item.kind === 'skill' && item.sources.length > 1) {
    // Use sourceCount because i18next treats count as pluralization input and these keys have no plural variants.
    return t(
      'components.native-chat.composer.skillMultipleSources',
      '{{sourceCount}} sources - agent resolves',
      { sourceCount: item.sources.length }
    )
  }
  return null
}

function scopeLabel(sourceKind: SkillSourceKind | undefined, t: Translate = translate): string {
  const labels: Record<string, string> = {
    repo: t('components.native-chat.composer.skillScopeProject', 'Project'),
    home: t('components.native-chat.composer.skillScopePersonal', 'Personal'),
    bundled: t('components.native-chat.composer.skillScopeBuiltIn', 'Built-in'),
    plugin: t('components.native-chat.composer.skillScopePlugin', 'Plugin')
  }
  return sourceKind ? (labels[sourceKind] ?? '') : ''
}

export const NativeChatMentionMenu = memo(function NativeChatMentionMenu({
  mention,
  activeIndex,
  listboxId,
  onChoose
}: {
  mention: NativeChatMentionFiles
  activeIndex: number
  listboxId: string
  onChoose: (path: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  const { files } = mention
  const room = useContext(NativeChatRoomContext)
  const selectedIndex = Math.min(activeIndex, files.length - 1)
  const chats = room?.chats
  const drilled = chats?.drill.open ?? null

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, mention.files, drilled, chats?.drill.activeIndex])

  // A bot's chats are read once its row has been highlighted or hovered a moment.
  const memberOf = (value: string) =>
    room?.mentions.find((mention) => nativeChatMentionValue(mention) === value)
  const [hovered, setHovered] = useState<string | null>(null)
  const highlighted = memberOf(files[selectedIndex] ?? '')?.id ?? null
  const prefetch = chats?.picker.prefetch
  useEffect(() => {
    const botId = hovered ?? highlighted
    if (!prefetch || !botId || drilled) {
      return
    }
    const timer = setTimeout(() => prefetch(botId), BOT_CHATS_PREFETCH_MS)
    return () => clearTimeout(timer)
  }, [prefetch, hovered, highlighted, drilled])

  if (chats && drilled) {
    const member = room?.mentions.find((entry) => entry.id === drilled.botId)
    const shown =
      chats.picker.shown?.botId === drilled.botId
        ? chats.picker.shown
        : {
            botId: drilled.botId,
            name: member?.name ?? '',
            avatar: member?.icon,
            chats: { status: 'loading' as const }
          }
    return (
      <PickerListbox id={listboxId}>
        <NativeChatMentionChatList
          shown={shown}
          filter={drilled.filter}
          activeIndex={chats.drill.activeIndex}
          listboxId={listboxId}
          activeItemRef={activeItemRef}
          onPick={chats.drill.pick}
          onBack={chats.drill.back}
          onRetry={chats.picker.retry}
        />
      </PickerListbox>
    )
  }

  const statusText =
    mention.files.length > 0
      ? null
      : mention.loading
        ? t('components.native-chat.composer.loadingFiles', 'Loading files...')
        : mention.failed
          ? t('components.native-chat.composer.filesLoadFailed', "Couldn't load files")
          : nativeChatMentionEmptyText(room !== null && !room.withFiles)

  // A bot's chat lists the other bots, then files, each under its heading.
  const bots = room?.withFiles ? files.filter((value) => memberOf(value)).length : 0
  const grouped = room?.withFiles === true && bots + room.unavailable.length > 0
  const option = (path: string, index: number) => {
    const member = room ? memberOf(path) : undefined
    const selected = index === selectedIndex
    const opens = member?.id && chats?.picker.offers(member.id) ? member.id : null
    const row = (
      <PickerOptionButton
        key={path}
        id={`${listboxId}-option-${index}`}
        selected={selected}
        activeItemRef={activeItemRef}
        onChoose={() => onChoose(path)}
        onPointerEnter={member?.id ? () => setHovered(member.id ?? null) : undefined}
        // Room for the Chats action; important, as the row's own px-2 comes later in the CSS.
        className={cn(member && 'items-center', opens && '!pr-20')}
      >
        <NativeChatMentionOption value={path} member={member} />
        {opens ? (
          <span className="sr-only">
            {t('components.native-chat.composer.chatsHint', 'Right arrow for chats')}
          </span>
        ) : null}
      </PickerOptionButton>
    )
    if (!opens || !chats) {
      return row
    }
    // Beside the option, never inside it, so the row stays one list option; → is the keyboard way.
    return (
      <div key={path} className="group/bot-row relative">
        {row}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => chats.drill.enter(opens)}
          className={cn(
            'absolute top-1/2 right-2 h-6 -translate-y-1/2 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground',
            selected ? 'flex' : 'hidden group-hover/bot-row:flex'
          )}
        >
          {t('components.native-chat.composer.botChats', 'Chats')}
          <ChevronRight aria-hidden className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <PickerListbox id={listboxId}>
      {grouped ? <PickerGroupHeading kind="bots" /> : null}
      <div className="flex flex-col gap-0.5" onPointerLeave={() => setHovered(null)}>
        {files.slice(0, bots).map(option)}
      </div>
      {grouped ? <NativeChatUnavailableMentions room={room} /> : null}
      {grouped && files.length > bots ? <PickerGroupHeading kind="files" /> : null}
      <div className="flex flex-col gap-0.5">
        {files.slice(bots).map((path, index) => option(path, index + bots))}
      </div>
      {statusText ? (
        <PickerStatus>
          {mention.loading ? <LoadingSpinner className="size-3.5" /> : null}
          {statusText}
        </PickerStatus>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {statusText ?? ''}
      </div>
    </PickerListbox>
  )
})

/** How long a bot row stays highlighted or hovered before its chats are read. */
const BOT_CHATS_PREFETCH_MS = 150
