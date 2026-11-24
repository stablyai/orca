// Import's picture: the old bot, an arrow, and the new bot (its picture changes like New bot's), or the bot an
// earlier import made. The old face pops in when it changes, as New group's faces do.
import React, { useEffect, useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { BotAvatar, BotAvatarTile } from './BotAvatar'
import { BotPicturePicker } from './BotPicturePicker'
import { popIn } from './BotPickList'
import type { NewBotPicture } from './use-new-bot-picture'

const FACE_POP_MS = 420

function Face({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex w-28 flex-col items-center gap-1.5">
      {children}
      <span className="h-4 max-w-full truncate text-xs leading-4 text-muted-foreground">
        {label}
      </span>
    </span>
  )
}

export function ImportBotHero({
  old,
  picture,
  existing
}: {
  /** The old bot: its initial, or null while there is none yet. `key` changes pop it in. */
  old: { key: string; initial: string | null; label: string }
  picture: NewBotPicture
  /** The bot an earlier import made, shown instead of the new one. */
  existing?: Bot | null
}): React.JSX.Element {
  const t = useTranslate()
  const oldRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    popIn(oldRef.current, FACE_POP_MS)
  }, [old.key])
  return (
    <div className="flex h-32 items-center justify-center gap-3">
      <Face label={old.label}>
        <span ref={oldRef} aria-hidden>
          {old.initial ? (
            <BotAvatarTile
              src={null}
              fallback={old.initial}
              className="size-18 rounded-2xl text-3xl"
            />
          ) : (
            <span className="flex size-18 items-center justify-center rounded-2xl border border-dashed border-input text-3xl font-semibold text-muted-foreground">
              ?
            </span>
          )}
        </span>
      </Face>
      <ArrowRight className="mb-5 size-5 shrink-0 text-muted-foreground" aria-hidden />
      {existing ? (
        <Face label={existing.name}>
          <BotAvatar bot={existing} size="large" className="size-24 rounded-2xl text-4xl" />
        </Face>
      ) : (
        <Face label={t('bots.import.newBotLabel', 'New bot')}>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t('bots.import.changePicture', 'Change picture')}
                className="rounded-2xl outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <BotAvatarTile
                  src={picture.src}
                  outfit={picture.outfitArt}
                  fallback=""
                  className="size-24 rounded-2xl"
                />
              </button>
            </PopoverTrigger>
            {/* A window too short for the open picker scrolls the card; any other fits it whole. */}
            <PopoverContent wheelScroll className="flex w-96 flex-col">
              <div className="scrollbar-sleek min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain">
                <BotPicturePicker
                  value={picture.value}
                  custom={picture.custom}
                  onChange={picture.onChange}
                  onUpload={picture.onUpload}
                  color={picture.color}
                  onColorChange={picture.onColorChange}
                  outfit={picture.outfit}
                  onOutfitChange={picture.onOutfitChange}
                />
              </div>
            </PopoverContent>
          </Popover>
        </Face>
      )}
    </div>
  )
}
