import type { RefObject } from 'react'
import { ArrowLeft, Search, Server, type LucideIcon, type LucideProps } from 'lucide-react'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const SEARCH_SHORTCUT_HINT = isMacUserAgent() ? '⌘F' : 'Ctrl+F'

type NavSection = {
  id: string
  title: string
  icon: LucideIcon | ((props: LucideProps) => React.JSX.Element)
  badge?: string
}

type RepoNavSection = NavSection & {
  badgeColor?: string
  isRemote?: boolean
}

type SettingsSidebarProps = {
  activeSectionId: string
  generalSections: NavSection[]
  repoSections: RepoNavSection[]
  hasRepos: boolean
  searchQuery: string
  searchInputRef?: RefObject<HTMLInputElement | null>
  onBack: () => void
  onSearchChange: (query: string) => void
  onSelectSection: (
    sectionId: string,
    modifiers: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
  ) => void
}

export function SettingsSidebar({
  activeSectionId,
  generalSections,
  repoSections,
  hasRepos,
  searchQuery,
  searchInputRef,
  onBack,
  onSearchChange,
  onSelectSection
}: SettingsSidebarProps): React.JSX.Element {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border/50 bg-card/40">
      <div className="border-b border-border/50 px-3 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="w-full justify-start gap-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to app
        </Button>
      </div>

      <div className="border-b border-border/50 px-3 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search settings"
            className="pl-9 pr-14"
          />
          {searchQuery === '' ? (
            <kbd className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center rounded border border-border/60 bg-background/40 px-1.5 py-px font-mono text-[10px] font-medium text-muted-foreground">
              {SEARCH_SHORTCUT_HINT}
            </kbd>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-3 py-4">
        <div className="space-y-5">
          <div className="space-y-1">
            {generalSections.map((section) => {
              const Icon = section.icon
              const isActive = activeSectionId === section.id

              return (
                <button
                  key={section.id}
                  onClick={(event) =>
                    onSelectSection(section.id, {
                      metaKey: event.metaKey,
                      ctrlKey: event.ctrlKey,
                      shiftKey: event.shiftKey,
                      altKey: event.altKey
                    })
                  }
                  className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon className="mr-2 size-4" />
                  {section.title}
                  {section.badge ? (
                    <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                      {section.badge}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>

          <div className="space-y-2">
            <p className="px-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Repositories
            </p>

            {repoSections.length > 0 ? (
              <div className="space-y-1">
                {repoSections.map((section) => {
                  const isActive = activeSectionId === section.id

                  return (
                    <button
                      key={section.id}
                      onClick={(event) =>
                        onSelectSection(section.id, {
                          metaKey: event.metaKey,
                          ctrlKey: event.ctrlKey,
                          shiftKey: event.shiftKey,
                          altKey: event.altKey
                        })
                      }
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      }`}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: section.badgeColor ?? '#6b7280' }}
                      />
                      <span className="truncate">{section.title}</span>
                      {section.isRemote && (
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                          <Server className="size-3" />
                          SSH
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="px-3 text-xs text-muted-foreground">
                {hasRepos ? 'No matching repository settings.' : 'No repositories added yet.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
