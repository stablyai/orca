import { BadgeCheck, Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { pluginOfficialLabel } from '../presentation/plugin-official-label'
import { Badge } from '../../ui/badge'
import { PluginCardArt, type PluginArtPalette } from './PluginCardArt'
import type { PluginListEntry } from './plugin-list-entries'
import { pluginArtShortcut, pluginArtTypes } from './PluginRowArt'
import { servedPluginHostImages } from '../../../../../shared/plugins/images/plugin-image-url'
import {
  pluginInstallCountLabel,
  usePluginInstallCount
} from '../presentation/plugin-install-count'

type PluginCardProps = {
  entry: PluginListEntry
  /** Added to the name link's accessible name, such as the installed status word. */
  statusText?: string
  palettes: readonly PluginArtPalette[]
  /** Replaces the description, e.g. an install error; keeps the two-line height. */
  notice?: { text: string; tone: 'destructive' | 'warning' }
  chips?: React.ReactNode
  action: React.ReactNode
  onOpen: () => void
  onIntent?: () => void
  onIntentEnd?: () => void
}

/**
 * One catalog plugin as a picture-first card. The name is the link and its hit area covers the
 * card; the action is a sibling button above it, so the card has two tab stops and no nesting.
 */
export function PluginCard({
  entry,
  statusText,
  palettes,
  notice,
  chips,
  action,
  onOpen,
  onIntent,
  onIntentEnd
}: PluginCardProps): React.JSX.Element {
  const installCount = usePluginInstallCount(entry)
  const cover =
    servedPluginHostImages(entry.installed?.images)?.cover ??
    servedPluginHostImages(entry.listing?.images)?.cover
  return (
    <li
      data-plugin-key={entry.pluginKey}
      className="group/plugin-card relative flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs transition-colors hover:border-foreground/20 has-[[data-plugin-row-name]:focus-visible]:ring-2 has-[[data-plugin-row-name]:focus-visible]:ring-ring"
      onPointerEnter={onIntent}
      onPointerLeave={onIntentEnd}
    >
      <div className="relative border-b border-border/70">
        {cover ? (
          // Why alt="": the name link says what this is; the cover is decoration here.
          <img
            src={cover.url}
            alt=""
            width={cover.width}
            height={cover.height}
            loading="lazy"
            decoding="async"
            className="block aspect-[16/10] w-full bg-muted object-cover"
          />
        ) : (
          <PluginCardArt
            types={pluginArtTypes(entry)}
            shortcut={pluginArtShortcut(entry)}
            fileType={entry.listing?.release?.fileTypes?.[0] ?? null}
            palettes={palettes}
            tintKey={entry.pluginKey}
          />
        )}
        {entry.installed ? (
          // Why on the art: the first thing a scan of the grid hits, readable over any cover.
          <Badge variant="dot" data-plugin-installed-badge="" className="absolute top-2 left-2">
            <Check className="text-status-success" aria-hidden="true" />
            {translate('auto.components.settings.PluginCardAction.installed', 'Installed')}
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 px-3.5 pt-3 pb-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h4 className="min-w-0 truncate text-sm font-semibold">
            <button
              type="button"
              data-plugin-row-name=""
              aria-label={[entry.name, entry.publisher, statusText].filter(Boolean).join(', ')}
              className="text-left outline-none after:absolute after:inset-0 after:content-['']"
              onClick={onOpen}
            >
              {entry.name}
            </button>
          </h4>
          {entry.official ? (
            <BadgeCheck
              className="plugin-security-chrome size-3.5 shrink-0 text-muted-foreground"
              role="img"
              aria-label={pluginOfficialLabel()}
            />
          ) : null}
        </div>
        <p className="h-4 truncate text-xs text-muted-foreground">
          {entry.publisher}
          {installCount !== null ? (
            <span data-plugin-install-count="">
              {entry.publisher ? ' · ' : ''}
              {pluginInstallCountLabel(installCount)}
            </span>
          ) : null}
        </p>
        <p
          data-tone={notice?.tone}
          className="mt-0.5 line-clamp-2 h-9 text-xs leading-[18px] text-muted-foreground data-[tone=destructive]:text-destructive data-[tone=warning]:text-status-warning-text"
        >
          {notice?.text ?? entry.description ?? ''}
        </p>
        {/* Why the footer wraps: the card clips overflow, so when chips and the action can't share a row the action drops below them instead of a chip being cut off. */}
        <div className="mt-auto flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1 pt-1.5">
          <div className="flex min-w-0 flex-wrap gap-1">{chips}</div>
          {/* Why a minimum width: Install and its in-flight label share one slot, so the footer never moves mid-install; installed controls may be wider. */}
          <div className="relative z-10 ml-auto flex min-w-32 shrink-0 items-center justify-end gap-1.5">
            {action}
          </div>
        </div>
      </div>
    </li>
  )
}
