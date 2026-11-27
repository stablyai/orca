import React from 'react'
import { LoaderCircle, MoreHorizontal, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { selectAppRailVisible } from '@/components/app-rail/app-rail-layout'
import { RAIL_PAGE_GUTTER_X } from './RailPage'

/** Hidden when the page is narrow; the control keeps its accessible name through `aria-label`. */
export const RAIL_PAGE_HIDE_NARROW = '@max-[40rem]/rail-page:hidden'

type HeadingProps = React.HTMLAttributes<HTMLHeadingElement> & Record<`data-${string}`, string>

/** The 52px band every rail page starts with. `children` replaces its content (Skills' selection header). */
export function RailPageBand({
  children,
  className,
  ...props
}: {
  children: React.ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>): React.JSX.Element {
  return (
    <header
      data-rail-page-header=""
      className={cn(
        'flex h-13 shrink-0 items-center gap-3 border-b border-border',
        RAIL_PAGE_GUTTER_X,
        className
      )}
      {...props}
    >
      {children}
    </header>
  )
}

export function RailPageHeader({
  title,
  headingProps,
  count,
  close,
  scope,
  meta,
  metaTitle,
  actions,
  className
}: {
  title: React.ReactNode
  headingProps?: HeadingProps
  /** A true total only (D1 R6); null hides the badge. */
  count?: number | null
  /** Shown only with the rail off: rail-on users leave through the rail, Esc or Back (UX-D Q1). */
  close?: { label: string; tooltip: string; onClose: () => void }
  scope?: React.ReactNode
  /** Muted context text after the scope; hidden when narrow. */
  meta?: React.ReactNode
  metaTitle?: string
  actions?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const railVisible = useAppStore(selectAppRailVisible)
  return (
    <RailPageBand className={className}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {close && !railVisible ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-toolbar"
                onClick={close.onClose}
                aria-label={close.label}
                data-rail-page-close=""
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {close.tooltip}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <h1
          {...headingProps}
          className={cn(
            'min-w-0 truncate text-[15px] font-semibold tracking-tight outline-none',
            headingProps?.className
          )}
        >
          {title}
        </h1>
        {typeof count === 'number' ? <RailPageCount value={count} /> : null}
        {scope ? (
          // Reserve a compact scope before truncating the title, then give the picker spare width.
          <div className="flex min-w-0 max-w-max grow shrink-0 basis-[min(calc(var(--spacing)*64),70%)] items-center gap-1.5">
            {scope}
          </div>
        ) : null}
        {meta ? (
          <span
            className={cn('min-w-0 truncate text-xs text-muted-foreground', RAIL_PAGE_HIDE_NARROW)}
            title={metaTitle}
          >
            {meta}
          </span>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </RailPageBand>
  )
}

export function RailPageCount({ value }: { value: number }): React.JSX.Element {
  return (
    <span
      data-rail-page-count=""
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 text-2xs font-medium tabular-nums text-muted-foreground"
    >
      {value}
    </span>
  )
}

/** One-click refresh on every rail page: same label, spinner and disabled-while-busy as the control it replaced. */
export function RailPageRefreshButton({
  label,
  tooltip,
  busy,
  disabled,
  onRefresh,
  busyCursor = false
}: {
  label: string
  tooltip?: string
  busy: boolean
  disabled?: boolean
  onRefresh: () => void
  /** Tasks/GitHub kept a wait cursor and pointer events while busy. */
  busyCursor?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-toolbar"
          onClick={onRefresh}
          disabled={disabled ?? busy}
          aria-busy={busy || undefined}
          aria-label={label}
          data-rail-page-refresh=""
          className={busyCursor ? 'disabled:pointer-events-auto disabled:cursor-wait' : undefined}
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltip ?? label}
      </TooltipContent>
    </Tooltip>
  )
}

/** The page's single filled action. Narrow drops the visible label; `aria-label` keeps the full name. */
export const RailPagePrimaryButton = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<typeof Button>, 'variant' | 'size' | 'children'> & {
    icon: React.ReactNode
    label: string
    'aria-label': string
  }
>(function RailPagePrimaryButton({ icon, label, ...props }, ref) {
  return (
    <Button ref={ref} type="button" size="toolbar" data-rail-page-primary="" {...props}>
      {icon}
      <span className={RAIL_PAGE_HIDE_NARROW}>{label}</span>
    </Button>
  )
})

/** A secondary header action: outline, label hidden when narrow. */
export const RailPageSecondaryButton = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<typeof Button>, 'variant' | 'size' | 'children'> & {
    icon: React.ReactNode
    label: string
    'aria-label': string
  }
>(function RailPageSecondaryButton({ icon, label, ...props }, ref) {
  return (
    <Button ref={ref} type="button" variant="outline" size="toolbar" {...props}>
      {icon}
      <span className={RAIL_PAGE_HIDE_NARROW}>{label}</span>
    </Button>
  )
})

/** ⋯ secondary actions. Children are stock DropdownMenu items. */
export function RailPageMoreMenu({
  children,
  label
}: {
  children: React.ReactNode
  label?: string
}): React.JSX.Element {
  const t = useTranslate()
  const name = label ?? t('auto.components.skills.SkillsPage.moreActions', 'More actions')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-toolbar"
          aria-label={name}
          data-rail-page-more=""
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}
