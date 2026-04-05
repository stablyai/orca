import { ArrowLeft, Search, type LucideIcon, type LucideProps } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

type NavSection = {
  id: string
  title: string
  icon: LucideIcon | ((props: LucideProps) => React.JSX.Element)
}

type RepoNavSection = NavSection & {
  badgeColor?: string
}

type SettingsSidebarProps = {
  activeSectionId: string
  generalSections: NavSection[]
  repoSections: RepoNavSection[]
  hasRepos: boolean
  searchQuery: string
  onBack: () => void
  onSearchChange: (query: string) => void
  onSelectSection: (sectionId: string) => void
}

export function SettingsSidebar({
  activeSectionId,
  generalSections,
  repoSections,
  hasRepos,
  searchQuery,
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
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search settings"
            className="pl-9"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-5">
          <div className="space-y-1">
            {generalSections.map((section) => {
              const Icon = section.icon
              const isActive = activeSectionId === section.id

              return (
                <button
                  key={section.id}
                  onClick={() => onSelectSection(section.id)}
                  className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    isActive
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon className="mr-2 size-4" />
                  {section.title}
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
                      onClick={() => onSelectSection(section.id)}
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
