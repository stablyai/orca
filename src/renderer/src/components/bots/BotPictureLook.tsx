// A mascot's look under the picture carousel: its tile color and what it wears.
import { ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
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
import { useBotMascotTileLooks } from './bot-mascot-look'
import { BotMascotBitmapTile } from './BotMascotBitmapTile'

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
  side,
  onPick
}: {
  id: BotMascotId
  color: string | null
  outfit: BotAvatarOutfit | null
  label: string
  selected: boolean
  /** Away from the other row, so the label never covers a tile. */
  side: 'top' | 'bottom'
  onPick: () => void
}): React.JSX.Element {
  const look = useBotMascotTileLooks(color, outfit)(id)
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
          {look.facedSrc ? (
            <BotAvatarTile
              src={look.facedSrc}
              outfit={look.outfit}
              fallback=""
              className="size-9 rounded-md"
            />
          ) : (
            <BotMascotBitmapTile
              id={id}
              color={color}
              outfit={look.outfit}
              className="size-9 rounded-md"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** What the mascot wears, under a row that names it: nothing, then each outfit, shown on the mascot itself. */
const OUTFIT_GRID_COLUMNS = 5

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
    party: t('bots.new.outfitParty', 'Party'),
    security: t('bots.new.outfitSecurity', 'Security')
  }
  const label = t('bots.new.pictureOutfit', 'Outfit')
  return (
    <Collapsible className="mt-1 flex flex-col items-center">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="disclosure" size="xs" className="group">
          {outfit
            ? t('bots.new.pictureOutfitsWorn', 'Outfits · {{outfit}}', { outfit: names[outfit] })
            : t('bots.new.pictureOutfits', 'Outfits')}
          <ChevronDown className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <div
          role="group"
          aria-label={label}
          className="mx-auto grid w-fit grid-cols-5 gap-2 pt-1 pb-1"
        >
          <OutfitTile
            id={id}
            color={color}
            outfit={null}
            label={t('bots.new.outfitNone', 'No outfit')}
            selected={outfit === null}
            side="top"
            onPick={() => onChange(null)}
          />
          {BOT_AVATAR_OUTFITS.map((worn, index) => (
            <OutfitTile
              key={worn}
              id={id}
              color={color}
              outfit={worn}
              label={names[worn]}
              selected={outfit === worn}
              // "No outfit" fills the first row's first place.
              side={index < OUTFIT_GRID_COLUMNS - 1 ? 'top' : 'bottom'}
              onPick={() => onChange(worn)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
