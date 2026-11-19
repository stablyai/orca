// A mascot's look under the picture carousel: its tile color and what it wears.
import { Plus } from 'lucide-react'
import { ColorPicker } from '@/components/ui/color-picker'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import {
  BOT_AVATAR_COLORS,
  DEFAULT_BOT_AVATAR_COLOR
} from '../../../../shared/bots/bot-avatar-color'
import { BOT_AVATAR_OUTFITS, type BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { BotAvatarTile } from './BotAvatar'
import { botMascotSrc } from './bot-mascot-look'

/** The mascot's tile color: the swatches, then any color. */
export function BotPictureColors({
  color,
  onChange
}: {
  color: string | null
  onChange: (color: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const current = color ?? DEFAULT_BOT_AVATAR_COLOR
  const isCustom = !BOT_AVATAR_COLORS.some((swatch) => swatch === current)
  const names: Record<(typeof BOT_AVATAR_COLORS)[number], string> = {
    '#b3dbf4': t('bots.new.colorSky', 'Sky'),
    '#ffffff': t('bots.new.colorWhite', 'White'),
    '#c9b8e8': t('bots.new.colorLavender', 'Lavender'),
    '#f4c4cf': t('bots.new.colorPink', 'Pink'),
    '#f8cfa8': t('bots.new.colorPeach', 'Peach'),
    '#f6e3a1': t('bots.new.colorButter', 'Butter'),
    '#c5dfb5': t('bots.new.colorSage', 'Sage'),
    '#b5e3d8': t('bots.new.colorMint', 'Mint'),
    '#8fa3b8': t('bots.new.colorSlate', 'Slate'),
    '#3a3f4b': t('bots.new.colorGraphite', 'Graphite'),
    '#1f2126': t('bots.new.colorInk', 'Ink')
  }
  return (
    <div
      role="group"
      aria-label={t('bots.new.pictureColor', 'Background color')}
      className="mt-2 flex flex-wrap items-center justify-center gap-1"
    >
      {BOT_AVATAR_COLORS.map((swatch) => (
        <button
          key={swatch}
          type="button"
          aria-label={names[swatch]}
          aria-pressed={swatch === current}
          style={{ backgroundColor: swatch }}
          onClick={() => onChange(swatch === DEFAULT_BOT_AVATAR_COLOR ? null : swatch)}
          className={cn(
            'size-4 cursor-pointer rounded-full border border-black/10 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-white/15',
            swatch === current && 'ring-2 ring-foreground ring-offset-2 ring-offset-popover'
          )}
        />
      ))}
      {isCustom ? (
        <span
          aria-hidden
          style={{ backgroundColor: current }}
          className="size-4 rounded-full border border-black/10 ring-2 ring-foreground ring-offset-2 ring-offset-popover dark:border-white/15"
        />
      ) : null}
      <Tooltip>
        <ColorPicker
          value={current}
          onChange={(next) => onChange(next.toLowerCase())}
          label={t('bots.new.pictureColorCustom', 'Custom color')}
          selected={isCustom}
          trigger={
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('bots.new.pictureColorCustom', 'Custom color')}
                className="flex size-4 cursor-pointer items-center justify-center rounded-full border border-border bg-muted text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          {t('bots.new.pictureColorCustom', 'Custom color')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function OutfitTile({
  id,
  color,
  outfit,
  label,
  selected,
  onPick
}: {
  id: BotMascotId
  color: string | null
  outfit: BotAvatarOutfit | null
  label: string
  selected: boolean
  onPick: () => void
}): React.JSX.Element {
  const src = botMascotSrc(id, color, outfit)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={selected}
          onClick={onPick}
          className={cn(
            'cursor-pointer rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-popover'
          )}
        >
          <BotAvatarTile src={src} fallback="" className="size-9 rounded-md" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** What the mascot wears: nothing, then each outfit, shown on the mascot itself. */
export function BotPictureOutfits({
  id,
  color,
  outfit,
  onChange
}: {
  id: BotMascotId
  color: string | null
  outfit: BotAvatarOutfit | null
  onChange: (outfit: BotAvatarOutfit | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const names: Record<BotAvatarOutfit, string> = {
    tie: t('bots.new.outfitTie', 'Tie'),
    detective: t('bots.new.outfitDetective', 'Detective'),
    'hard-hat': t('bots.new.outfitHardHat', 'Hard hat'),
    reviewer: t('bots.new.outfitReviewer', 'Reviewer'),
    'night-shift': t('bots.new.outfitNightShift', 'Night shift'),
    artist: t('bots.new.outfitArtist', 'Artist'),
    scientist: t('bots.new.outfitScientist', 'Scientist'),
    security: t('bots.new.outfitSecurity', 'Security'),
    party: t('bots.new.outfitParty', 'Party')
  }
  return (
    <div
      role="group"
      aria-label={t('bots.new.pictureOutfit', 'Outfit')}
      className="mx-auto mb-1 grid w-fit grid-cols-5 gap-2 pt-1"
    >
      <OutfitTile
        id={id}
        color={color}
        outfit={null}
        label={t('bots.new.outfitNone', 'No outfit')}
        selected={outfit === null}
        onPick={() => onChange(null)}
      />
      {BOT_AVATAR_OUTFITS.map((worn) => (
        <OutfitTile
          key={worn}
          id={id}
          color={color}
          outfit={worn}
          label={names[worn]}
          selected={outfit === worn}
          onPick={() => onChange(worn)}
        />
      ))}
    </div>
  )
}
