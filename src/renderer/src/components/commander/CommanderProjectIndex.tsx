import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { CommanderActivity, ProjectActivity } from './commander-project-overview'

const PAGE_SIZE = 40
const COUNT_ACTIVITIES = ['blocked', 'waiting', 'working', 'all'] as const
const STATUS_MARKS = ['bg-agent-question', 'bg-agent-question/40', 'bg-agent-working'] as const

export function CommanderProjectIndex({
  projects,
  selectedProjectId,
  activity,
  onSelect
}: {
  projects: readonly ProjectActivity<unknown>[]
  selectedProjectId: string | null
  activity: CommanderActivity
  onSelect: (id: string, activity: CommanderActivity) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const search = query.trim().toLowerCase()
  const matches = projects.filter(
    (p) => !search || p.id.toLowerCase().includes(search) || p.name.toLowerCase().includes(search)
  )
  const headers = [
    t('commander.project', 'Project'),
    t('commander.blocked', 'Blocked'),
    t('commander.waiting', 'Waiting'),
    t('dashboardPopout.bucket.working', 'Working'),
    t('commander.total', 'Total')
  ]
  return (
    <section
      className="@container flex min-h-0 max-h-[35%] flex-col border-b border-border"
      aria-label={t('commander.projects', 'Projects')}
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <h2 className="text-sm font-semibold">
          {t('commander.projects', 'Projects')}{' '}
          <span className="font-normal tabular-nums text-muted-foreground">{projects.length}</span>
        </h2>
        <Input
          className="ml-auto h-7 max-w-56"
          placeholder={t('commander.searchProjects', 'Search projects')}
          aria-label={t('commander.searchProjects', 'Search projects')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setLimit(PAGE_SIZE)
          }}
        />
      </div>
      <div className="scrollbar-sleek min-h-0 overflow-auto px-2 pb-2 @lg:px-4">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr>
              {headers.map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={cn(
                    'px-1 py-1 text-right font-medium @lg:px-2',
                    index === 0 && 'w-full text-left'
                  )}
                >
                  {index > 0 && index <= STATUS_MARKS.length && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mr-1 hidden size-1.5 @lg:inline-block rounded-full align-middle',
                        STATUS_MARKS[index - 1]
                      )}
                    />
                  )}
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matches.slice(0, limit).map((project) => {
              const label = project.id.startsWith('github:')
                ? project.id.slice('github:'.length)
                : project.name
              return (
                <tr
                  key={project.id}
                  data-current={selectedProjectId === project.id}
                  className="border-t border-border/50 hover:bg-accent data-[current=true]:bg-accent"
                >
                  <th scope="row" className="text-left font-normal">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      title={label}
                      aria-pressed={selectedProjectId === project.id}
                      onClick={() => onSelect(project.id, 'all')}
                    >
                      <span className="min-w-0 truncate">{label}</span>
                      <span
                        aria-hidden="true"
                        className="hidden h-1 w-1/3 max-w-48 @lg:flex shrink-0 overflow-hidden rounded-full bg-muted"
                      >
                        {project.cards.length > 0 &&
                          [project.blocked, project.waiting, project.working].map(
                            (count, index) => (
                              <span
                                key={STATUS_MARKS[index]}
                                className={STATUS_MARKS[index]}
                                style={{ width: `${(count * 100) / project.cards.length}%` }}
                              />
                            )
                          )}
                      </span>
                    </button>
                  </th>
                  {COUNT_ACTIVITIES.map((scope, index) => {
                    const value = scope === 'all' ? project.cards.length : project[scope]
                    const selected = selectedProjectId === project.id && scope === activity
                    return (
                      <td className="text-right" key={scope}>
                        {value > 0 ? (
                          <Button
                            type="button"
                            size="xs"
                            variant={selected ? 'secondary' : 'ghost-on-accent'}
                            aria-label={`${label} · ${headers[index + 1]} · ${value}`}
                            aria-pressed={selected}
                            onClick={() => onSelect(project.id, scope)}
                          >
                            {value}
                          </Button>
                        ) : (
                          <span className="px-2 text-muted-foreground">{value}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {matches.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            {t('commander.noProjects', 'No matching projects.')}
          </p>
        )}
        {matches.length > limit && (
          <Button variant="ghost" size="sm" onClick={() => setLimit(limit + PAGE_SIZE)}>
            {t('commander.showMore', 'Show more projects')}
          </Button>
        )}
      </div>
    </section>
  )
}
