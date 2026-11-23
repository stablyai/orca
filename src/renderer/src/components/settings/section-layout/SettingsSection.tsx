import type React from 'react'
import { createContext, useContext } from 'react'
import { cn } from '@/lib/class-names'
import { useAppStore } from '../../../store/index'
import type { SettingsSearchEntry } from '../search/settings-search'
import { matchesSettingsSearch } from '../search/settings-search'

// Share active section through context to avoid threading it through every section call.
const ActiveSettingsSectionContext = createContext<string | null>(null)

export const ActiveSettingsSectionProvider = ActiveSettingsSectionContext.Provider

type SettingsSectionProps = {
  id: string
  title: string
  description: React.ReactNode
  searchEntries?: SettingsSearchEntry[]
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
  badge?: string
  badgeAccessory?: React.ReactNode
  forceVisible?: boolean
  /** Mount only the selected section, even when search lists several matches. */
  isActive?: boolean
  /** Header-scoped actions, such as Import from Ghostty. */
  headerAction?: React.ReactNode
  fullWidthDescriptionOnNarrow?: boolean
  /** Drops the title block while the body shows its own page header (a plugin's page). */
  hideHeader?: boolean
  /** Click handler on the section title — the hook for hidden staff
   *  affordances (Option-click reveals), mirroring the Updates header. */
  onTitleClick?: (event: React.MouseEvent<HTMLHeadingElement>) => void
}

export function SettingsSection({
  id,
  title,
  description,
  searchEntries,
  children,
  className,
  bodyClassName,
  badge,
  badgeAccessory,
  forceVisible = false,
  isActive,
  headerAction,
  fullWidthDescriptionOnNarrow = false,
  hideHeader = false,
  onTitleClick
}: SettingsSectionProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const activeFromContext = useContext(ActiveSettingsSectionContext)
  const sectionIsActive = isActive ?? activeFromContext === id
  const hasQuery = query.trim() !== ''
  const matchesQuery = !searchEntries || matchesSettingsSearch(query, searchEntries)
  if (!forceVisible) {
    if (hasQuery) {
      if (!sectionIsActive || !matchesQuery) {
        return null
      }
    } else if (!sectionIsActive) {
      return null
    }
  }

  return (
    <section
      id={id}
      data-settings-section={id}
      className={cn(
        'scroll-mt-8 space-y-6',
        fullWidthDescriptionOnNarrow && '@container/settings-section',
        className
      )}
    >
      <div
        hidden={hideHeader}
        className={cn(
          'flex items-start justify-between gap-4 border-b border-border/60 pb-5',
          fullWidthDescriptionOnNarrow &&
            '@max-lg/settings-section:grid @max-lg/settings-section:grid-cols-[minmax(0,1fr)_auto] @max-lg/settings-section:gap-2'
        )}
      >
        <div
          className={cn(
            'min-w-0 flex-1',
            fullWidthDescriptionOnNarrow
              ? '@max-lg/settings-section:contents @lg/settings-section:space-y-2'
              : 'space-y-2'
          )}
        >
          <h2
            className={cn(
              'flex flex-wrap items-center gap-2 text-2xl font-semibold leading-tight text-foreground',
              fullWidthDescriptionOnNarrow &&
                '@max-lg/settings-section:text-xl @max-xs/settings-section:text-settings-heading wrap-anywhere'
            )}
            onClick={onTitleClick}
          >
            {title}
            {badge ? (
              <span className="text-2xs font-normal text-muted-foreground">{badge}</span>
            ) : null}
            {badgeAccessory}
          </h2>
          <p
            className={cn(
              'max-w-3xl text-sm leading-6 text-muted-foreground',
              fullWidthDescriptionOnNarrow &&
                '@max-lg/settings-section:col-span-2 @max-lg/settings-section:row-start-2 @max-xs/settings-section:text-settings-detail'
            )}
          >
            {description}
          </p>
        </div>
        {headerAction ? (
          <div
            className={cn(
              'shrink-0',
              fullWidthDescriptionOnNarrow &&
                '@max-lg/settings-section:col-start-2 @max-lg/settings-section:row-start-1'
            )}
          >
            {headerAction}
          </div>
        ) : null}
      </div>
      {/* Panes are built from SettingsGroup cards; the body draws no card of its own. */}
      <div className={cn('flex flex-col gap-8', bodyClassName)}>{children}</div>
    </section>
  )
}
