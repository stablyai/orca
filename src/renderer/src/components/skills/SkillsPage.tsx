import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Clock, FolderOpen, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillProvider,
  SkillSourceKind
} from '../../../../shared/skills'
import { countSkillsBySource, filterSkills, type SkillsFilterState } from './skills-filter'

const providerLabels: Record<SkillProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'agent-skills': 'Agent Skills'
}

const sourceLabels: Record<SkillSourceKind, string> = {
  home: 'Home',
  repo: 'Repository',
  bundled: 'Bundled',
  plugin: 'Plugin'
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

const EMPTY_SKILLS: DiscoveredSkill[] = []

function formatUpdatedAt(value: number | null): string {
  return value ? dateFormatter.format(new Date(value)) : 'Unknown'
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function SkillCard({ skill }: { skill: DiscoveredSkill }): React.JSX.Element {
  const revealSkill = async (): Promise<void> => {
    const result = await window.api.shell.openInFileManager(skill.skillFilePath)
    if (!result.ok) {
      toast.error('Could not reveal skill file')
    }
  }

  return (
    <Card className="rounded-lg">
      <CardContent className="space-y-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
            <BookOpen className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold">{skill.name}</h3>
              <Badge
                variant={skill.installed ? 'secondary' : 'outline'}
                className="h-5 text-[10px]"
              >
                {skill.installed ? 'Local' : 'Available'}
              </Badge>
              <Badge variant="outline" className="h-5 text-[10px]">
                {sourceLabels[skill.sourceKind]}
              </Badge>
            </div>
            {skill.description ? (
              <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                {skill.description}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">No description found.</p>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => {
                  void revealSkill()
                }}
              >
                <FolderOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Reveal file
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="grid gap-2 text-[11px] text-muted-foreground md:grid-cols-[1fr_auto_auto] md:items-center">
          <div className="min-w-0 truncate font-mono" title={skill.skillFilePath}>
            {skill.skillFilePath}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {skill.providers.map((provider) => (
              <Badge key={provider} variant="outline" className="h-5 text-[10px]">
                {providerLabels[provider]}
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-3 whitespace-nowrap">
            <span>{skill.sourceLabel}</span>
            <span>{pluralize(skill.fileCount, 'file')}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {formatUpdatedAt(skill.updatedAt)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function EmptyState({
  loading,
  hasSkills,
  onRefresh
}: {
  loading: boolean
  hasSkills: boolean
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {loading ? (
          <Loader2 className="size-7 animate-spin text-muted-foreground" />
        ) : (
          <BookOpen className="size-7 text-muted-foreground" />
        )}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {loading ? 'Scanning skills' : hasSkills ? 'No matches' : 'No local skills found'}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {hasSkills
              ? 'Adjust the search or filters.'
              : 'Checked local home, repository, bundled, and plugin skill folders.'}
          </p>
        </div>
        {!loading ? (
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default function SkillsPage(): React.JSX.Element {
  const closeSkillsPage = useAppStore((s) => s.closeSkillsPage)
  const [result, setResult] = useState<SkillDiscoveryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<SkillsFilterState>({
    query: '',
    sourceKind: 'all',
    provider: 'all'
  })

  const loadSkills = async (): Promise<void> => {
    setLoading(true)
    try {
      setResult(await window.api.skills.discover())
    } catch (error) {
      console.error('Failed to discover skills:', error)
      toast.error('Could not scan local skills')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSkills()
  }, [])

  const skills = result?.skills ?? EMPTY_SKILLS
  const visibleSkills = useMemo(() => filterSkills(skills, filters), [filters, skills])
  const sourceCounts = useMemo(() => countSkillsBySource(skills), [skills])
  const activeSourceCount = result?.sources.filter((source) => source.exists).length ?? 0

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BookOpen className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Skills</h1>
            <p className="truncate text-xs text-muted-foreground">
              {pluralize(skills.length, 'skill')} from {pluralize(activeSourceCount, 'source')}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={closeSkillsPage}
          aria-label="Close Skills"
        >
          <X className="size-4" />
        </Button>
      </header>

      <section className="flex shrink-0 flex-col gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(event) => setFilters((next) => ({ ...next, query: event.target.value }))}
              placeholder="Search skills"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Select
              value={filters.provider}
              onValueChange={(value) =>
                setFilters((next) => ({
                  ...next,
                  provider: value as SkillsFilterState['provider']
                }))
              }
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="claude">Claude</SelectItem>
                <SelectItem value="agent-skills">Agent Skills</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.sourceKind}
              onValueChange={(value) =>
                setFilters((next) => ({
                  ...next,
                  sourceKind: value as SkillsFilterState['sourceKind']
                }))
              }
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="home">Home</SelectItem>
                <SelectItem value="repo">Repository</SelectItem>
                <SelectItem value="bundled">Bundled</SelectItem>
                <SelectItem value="plugin">Plugin</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={loading}
              onClick={() => {
                void loadSkills()
              }}
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {(['home', 'repo', 'bundled', 'plugin'] as const).map((sourceKind) => (
            <span key={sourceKind} className="rounded-full border border-border px-2 py-1">
              {sourceLabels[sourceKind]} {sourceCounts[sourceKind]}
            </span>
          ))}
        </div>
      </section>

      <section className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {visibleSkills.length > 0 ? (
          <div className="mx-auto flex max-w-5xl flex-col gap-3">
            {visibleSkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        ) : (
          <EmptyState
            loading={loading}
            hasSkills={skills.length > 0}
            onRefresh={() => void loadSkills()}
          />
        )}
      </section>
    </main>
  )
}
