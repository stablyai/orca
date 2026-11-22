import React from 'react'
import { ChevronDown, LayoutGrid, Plus, Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAvatar } from '../BotAvatar'
import { composioLogoUrl } from '../../../../../shared/composio/composio-apps'
import { botAppCategoryName, type BotAppCategory } from './bot-app-catalog'
import { BotAppCategoryIcon } from './BotAppCategoryIcon'

/** What the list shows: everything, the bot's own, one category, or Composio's apps. */
export type BotAppsView = 'all' | 'mine' | BotAppCategory | 'composio' | 'catalog'

export type BotAppsRailProps = {
  bot: Pick<Bot, 'id' | 'name' | 'avatar' | 'hostId'>
  view: BotAppsView
  onView: (view: BotAppsView) => void
  /** How many apps the bot has; none hides On <bot>. */
  mineCount: number
  /** Categories with an app, added or not, and how many. */
  categories: readonly { category: BotAppCategory; count: number }[]
  composio: boolean
  onAddByUrl: (() => void) | null
  onWebhooks: (() => void) | null
}

/**
 * One line at a fixed height: a long label ends in an ellipsis (full text on hover), the count stays put.
 * Selected and focus match Settings' sidebar rows; hover is only a faint tint, like the worktree sidebar's rows, so it never reads as selected.
 */
function RailButton({
  pressed,
  onClick,
  icon,
  label,
  count
}: {
  pressed?: boolean
  onClick: () => void
  icon?: React.ReactNode
  label: string
  count?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={label}
      className={cn(
        'flex h-7 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-worktree-sidebar-ring/50 [&_img]:shrink-0 [&_svg]:shrink-0',
        pressed
          ? 'bg-worktree-sidebar-accent font-medium text-worktree-sidebar-accent-foreground ring-1 ring-worktree-sidebar-ring/25'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-accent/20'
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="shrink-0 text-xs tabular-nums opacity-70">{count}</span>
      ) : null}
    </button>
  )
}

const Divider = () => <div className="mx-1 my-1.5 h-px bg-border" />

/** The dialog's left rail: All apps and On <bot>, the categories, Composio, then Add by URL and Webhooks. */
export function BotAppsRail(props: BotAppsRailProps): React.JSX.Element {
  const t = useTranslate()
  const { view, onView } = props
  return (
    <div className="shrink-0 max-sm:hidden">
      <nav
        aria-label={t('bots.apps.categories', 'Categories')}
        className="flex h-full w-52 flex-col gap-px border-r border-border px-2 py-2.5"
      >
        <RailButton
          pressed={view === 'all'}
          onClick={() => onView('all')}
          icon={<LayoutGrid className="size-3.5" />}
          label={t('bots.apps.allApps', 'All apps')}
        />
        {props.mineCount > 0 ? (
          <RailButton
            pressed={view === 'mine'}
            onClick={() => onView('mine')}
            icon={<BotAvatar bot={props.bot} className="size-3.5 rounded-[3px] text-3xs" />}
            label={t('bots.apps.onBot', 'On {{bot}}', { bot: props.bot.name })}
            count={props.mineCount}
          />
        ) : null}
        {props.categories.length > 0 ? <Divider /> : null}
        {props.categories.map(({ category, count }) => (
          <RailButton
            key={category}
            pressed={view === category}
            onClick={() => onView(category)}
            icon={<BotAppCategoryIcon category={category} />}
            label={botAppCategoryName(category)}
            count={count}
          />
        ))}
        {props.composio ? (
          <>
            <Divider />
            <RailButton
              pressed={view === 'composio' || view === 'catalog'}
              onClick={() => onView('composio')}
              icon={<img src={composioLogoUrl('composio')} alt="" className="size-3.5" />}
              label={t('bots.apps.composio.withComposio', 'With Composio')}
            />
          </>
        ) : null}
        <span className="flex-1" />
        {props.onAddByUrl || props.onWebhooks ? <Divider /> : null}
        {props.onAddByUrl ? (
          <RailButton
            onClick={props.onAddByUrl}
            icon={<Plus className="size-3.5" />}
            label={t('bots.apps.addByUrl', 'Add by URL')}
          />
        ) : null}
        {props.onWebhooks ? (
          <RailButton
            onClick={props.onWebhooks}
            icon={<Webhook className="size-3.5" />}
            label={t('bots.webhooks.name', 'Webhooks')}
          />
        ) : null}
      </nav>
    </div>
  )
}

/** The rail as one menu, for a window too narrow for it. */
export function BotAppsRailMenu(props: BotAppsRailProps): React.JSX.Element {
  const t = useTranslate()
  const options: { value: BotAppsView; label: string; icon: React.ReactNode }[] = [
    {
      value: 'all',
      label: t('bots.apps.allApps', 'All apps'),
      icon: <LayoutGrid className="size-3.5" />
    },
    ...(props.mineCount > 0
      ? [
          {
            value: 'mine' as const,
            label: t('bots.apps.onBot', 'On {{bot}}', { bot: props.bot.name }),
            icon: <BotAvatar bot={props.bot} className="size-3.5 rounded-[3px] text-3xs" />
          }
        ]
      : []),
    ...props.categories.map(({ category }) => ({
      value: category,
      label: botAppCategoryName(category),
      icon: <BotAppCategoryIcon category={category} />
    })),
    ...(props.composio
      ? [
          {
            value: 'composio' as const,
            label: t('bots.apps.composio.withComposio', 'With Composio'),
            icon: <img src={composioLogoUrl('composio')} alt="" className="size-3.5 shrink-0" />
          }
        ]
      : [])
  ]
  const current =
    options.find((option) => option.value === (props.view === 'catalog' ? 'composio' : props.view))
      ?.label ?? options[0].label
  return (
    <div className="sm:hidden">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" title={current} className="max-w-48">
            <span className="min-w-0 truncate">{current}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={props.view}
            onValueChange={(value) => {
              const picked = options.find((option) => option.value === value)
              if (picked) {
                props.onView(picked.value)
              }
            }}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.icon}
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {props.onAddByUrl || props.onWebhooks ? <DropdownMenuSeparator /> : null}
          {props.onAddByUrl ? (
            <DropdownMenuItem onSelect={props.onAddByUrl}>
              <Plus />
              {t('bots.apps.addByUrl', 'Add by URL')}
            </DropdownMenuItem>
          ) : null}
          {props.onWebhooks ? (
            <DropdownMenuItem onSelect={props.onWebhooks}>
              <Webhook />
              {t('bots.webhooks.name', 'Webhooks')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
