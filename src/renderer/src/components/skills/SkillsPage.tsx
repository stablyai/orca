import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, Loader2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import { useActiveSkillDiscoveryRuntimeTarget } from '@/hooks/use-active-skill-discovery-runtime-target'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { SkillCard } from './SkillCard'
import { pluralize, sourceLabels } from './skill-display-labels'
import { countSkillsBySource, filterSkills, type SkillsFilterState } from './skills-filter'
import { translate } from '@/i18n/i18n'

const EMPTY_SKILLS: DiscoveredSkill[] = []

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
            {loading
              ? translate('auto.components.skills.SkillsPage.cd7893fbc1', 'Scanning skills')
              : hasSkills
                ? translate('auto.components.skills.SkillsPage.6a62a0168c', 'No matches')
                : translate('auto.components.skills.SkillsPage.4acd6d68ec', 'No skills found')}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {hasSkills
              ? translate(
                  'auto.components.skills.SkillsPage.08a321a984',
                  'Adjust the search or filters.'
                )
              : translate(
                  'auto.components.skills.SkillsPage.ab5b777350',
                  'Checked home, repository, bundled, and plugin skill folders.'
                )}
          </p>
        </div>
        {!loading ? (
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="size-4" />
            {translate('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default function SkillsPage(): React.JSX.Element {
  const closeSkillsPage = useAppStore((s) => s.closeSkillsPage)
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const [result, setResult] = useState<SkillDiscoveryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<SkillsFilterState>({
    query: '',
    sourceKind: 'all',
    provider: 'all'
  })
  const mountedRef = useMountedRef()
  const scanGenerationRef = useRef(0)

  const loadSkills = useCallback(async (): Promise<void> => {
    setLoading(true)
    // Why: a cold local scan walks every skill root, so switching runtimes can
    // land a stale result after a newer one. Only the newest scan may write.
    const scanGeneration = ++scanGenerationRef.current
    const isCurrentScan = (): boolean =>
      mountedRef.current && scanGeneration === scanGenerationRef.current
    if (!runtimeTarget) {
      // Why: keep scanning until the owning runtime is known, rather than
      // showing the client's skills to someone whose skills live remotely.
      return
    }
    try {
      const nextResult = await discoverSkillsForRuntimeTarget(runtimeTarget)
      if (isCurrentScan()) {
        setResult(nextResult)
      }
    } catch (error) {
      console.error('Failed to discover skills:', error)
      if (isCurrentScan()) {
        toast.error(
          translate('auto.components.skills.SkillsPage.ea72d6185b', 'Could not scan skills')
        )
      }
    } finally {
      if (isCurrentScan()) {
        setLoading(false)
      }
    }
  }, [mountedRef, runtimeTarget])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    const hasVisibleOverlay = (): boolean =>
      Array.from(
        document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
      ).some((element) => {
        if (!(element instanceof HTMLElement)) {
          return false
        }
        if (element.closest('[aria-hidden="true"]')) {
          return false
        }
        const style = window.getComputedStyle(element)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        )
      })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: menus and dialogs own Escape before page-level navigation.
      if (hasVisibleOverlay()) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target?.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      ) {
        return
      }
      event.preventDefault()
      closeSkillsPage()
    }

    // Why: tooltips can consume Escape before bubble listeners see it. Capture
    // keeps page-level back navigation reliable when no overlay is active.
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeSkillsPage])

  const skills = result?.skills ?? EMPTY_SKILLS
  const visibleSkills = useMemo(() => filterSkills(skills, filters), [filters, skills])
  const sourceCounts = useMemo(() => countSkillsBySource(skills), [skills])
  const activeSourceCount = result?.sources.filter((source) => source.exists).length ?? 0

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="outline" size="sm" onClick={closeSkillsPage} className="shrink-0 gap-1.5">
          <ArrowLeft className="size-3.5" />
          {translate('auto.components.skills.SkillsPage.7e828fb2c6', 'Back')}
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BookOpen className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold">
                {translate('auto.components.skills.SkillsPage.f43ad6edf3', 'Skills')}
              </h1>
              <Badge variant="secondary">
                {translate('auto.components.skills.SkillsPage.b088e0785d', 'Beta')}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {pluralize(skills.length, 'skill')}{' '}
              {translate('auto.components.skills.SkillsPage.e46e162e2e', 'from')}
              {pluralize(activeSourceCount, 'source')}
            </p>
          </div>
        </div>
      </header>

      <section className="flex shrink-0 flex-col gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(event) => setFilters((next) => ({ ...next, query: event.target.value }))}
              placeholder={translate(
                'auto.components.skills.SkillsPage.a68dee6a32',
                'Search skills'
              )}
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
                <SelectItem value="all">
                  {translate('auto.components.skills.SkillsPage.39b6998ddb', 'All providers')}
                </SelectItem>
                <SelectItem value="codex">
                  {translate('auto.components.skills.SkillsPage.426be2aac6', 'Codex')}
                </SelectItem>
                <SelectItem value="claude">
                  {translate('auto.components.skills.SkillsPage.fb6bf60b52', 'Claude')}
                </SelectItem>
                <SelectItem value="agent-skills">
                  {translate('auto.components.skills.SkillsPage.38e0951c3a', 'Agent Skills')}
                </SelectItem>
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
                <SelectItem value="all">
                  {translate('auto.components.skills.SkillsPage.0bc1379f4c', 'All sources')}
                </SelectItem>
                <SelectItem value="home">
                  {translate('auto.components.skills.SkillsPage.571c5818c1', 'Home')}
                </SelectItem>
                <SelectItem value="repo">
                  {translate('auto.components.skills.SkillsPage.aa59462502', 'Repository')}
                </SelectItem>
                <SelectItem value="bundled">
                  {translate('auto.components.skills.SkillsPage.4d177feabd', 'Bundled')}
                </SelectItem>
                <SelectItem value="plugin">
                  {translate('auto.components.skills.SkillsPage.984405683f', 'Plugin')}
                </SelectItem>
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
              {translate('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
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
