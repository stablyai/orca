import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { RepoIcon } from '../../../../shared/repo-icon'

export function ProjectConversationSection({
  label,
  icon,
  collapsed,
  onToggle,
  newChat,
  children,
  more,
  onMore,
  menu
}: {
  label: string
  icon?: RepoIcon | null
  collapsed: boolean
  onToggle: () => void
  newChat?: ReactNode
  children: ReactNode
  more: boolean
  onMore: () => void
  menu?: ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-3" aria-label={label}>
      <div className="group/project flex min-w-0 items-center gap-1 rounded-md px-1 hover:bg-sidebar-accent focus-within:bg-sidebar-accent">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center">
            <RepoIconGlyph
              repoIcon={icon}
              className="size-4 group-hover/project:opacity-0 group-focus-within/project:opacity-0"
              iconClassName="size-4"
            />
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'absolute size-3.5 opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100',
                !collapsed && 'rotate-90'
              )}
            />
          </span>
          <span className="truncate font-medium">{label}</span>
        </button>
        <div className="flex shrink-0 items-center opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 [@media(hover:none)]:opacity-100">
          {menu}
          {newChat}
        </div>
      </div>
      {!collapsed ? (
        <div>
          {children}
          {more ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onMore}
              className="ml-6 justify-start"
            >
              {translate('projectConversations.showMore', 'Show more')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
