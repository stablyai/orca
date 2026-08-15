import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { countSkillsBySource, filterSkills, type SkillsFilterState } from './skills-filter'
import { translate } from '@/i18n/i18n'
import { SkillsFilterBar } from './SkillsFilterBar'
import { SkillsGalleryGrid } from './SkillsGalleryGrid'

const EMPTY_SKILLS: DiscoveredSkill[] = []

export function pluralizeSkillCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
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
    <div className="flex min-h-[20rem] flex-1 items-center justify-center p-8">
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
                : translate(
                    'auto.components.skills.SkillsPage.4acd6d68ec',
                    'No local skills found'
                  )}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {hasSkills
              ? translate(
                  'auto.components.skills.SkillsPage.08a321a984',
                  'Adjust the search or filters.'
                )
              : translate(
                  'auto.components.skills.SkillsPage.ab5b777350',
                  'Checked local home, repository, bundled, and plugin skill folders.'
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

export function SkillsGallery({
  onSummaryChange
}: {
  onSummaryChange?: (summary: { skillCount: number; activeSourceCount: number }) => void
}): React.JSX.Element {
  const [result, setResult] = useState<SkillDiscoveryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<SkillsFilterState>({
    query: '',
    sourceKind: 'all',
    provider: 'all'
  })
  const mountedRef = useMountedRef()

  const loadSkills = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const nextResult = await window.api.skills.discover()
      if (mountedRef.current) {
        setResult(nextResult)
      }
    } catch (error) {
      console.error('Failed to discover skills:', error)
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.skills.SkillsPage.ea72d6185b', 'Could not scan local skills')
        )
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const skills = result?.skills ?? EMPTY_SKILLS
  const visibleSkills = useMemo(() => filterSkills(skills, filters), [filters, skills])
  const sourceCounts = useMemo(() => countSkillsBySource(skills), [skills])
  const activeSourceCount = result?.sources.filter((source) => source.exists).length ?? 0

  useEffect(() => {
    onSummaryChange?.({ skillCount: skills.length, activeSourceCount })
  }, [activeSourceCount, onSummaryChange, skills.length])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SkillsFilterBar
        filters={filters}
        sourceCounts={sourceCounts}
        loading={loading}
        onFiltersChange={setFilters}
        onRefresh={() => void loadSkills()}
      />

      <section className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {visibleSkills.length > 0 ? (
          <SkillsGalleryGrid skills={visibleSkills} />
        ) : (
          <EmptyState
            loading={loading}
            hasSkills={skills.length > 0}
            onRefresh={() => void loadSkills()}
          />
        )}
      </section>
    </div>
  )
}
