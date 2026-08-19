import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import { useActiveSkillDiscoveryRuntimeTarget } from '@/hooks/use-active-skill-discovery-runtime-target'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { SkillsList } from './SkillsList'
import { SkillShareDialog } from './SkillShareDialog'
import { SkillInstallDialog } from './SkillInstallDialog'
import { SkillInstallManagementDialog } from './SkillInstallManagementDialog'
import { SkillsPageHeader } from './SkillsPageHeader'
import { SkillsFilterToolbar } from './SkillsFilterToolbar'
import { SkillsSelectionHeader } from './SkillsSelectionHeader'
import {
  SkillsEmptyState,
  SkillsListSkeleton,
  SkillsNoMatchesState,
  SkillsRemoteShareNotice,
  SkillsScanErrorBand
} from './skills-page-states'
import { SKILLS_PAGE_COLUMN } from './skills-page-column'
import { scannedSkillSourceCount, summarizeSkillSources } from './skill-source-inventory'
import { useSkillDiscoveryHostLabel } from './use-skill-discovery-host-label'
import { countSkillsBySource, filterSkills, type SkillsFilterState } from './skills-filter'
import { skillAgentByRootPath, skillAgentOptions } from './skill-agent-filter'
import { SkillSharedLinksView } from './SkillSharedLinksView'
import { useOwnedSkillShares } from './use-owned-skill-shares'
import type { SkillsPageView } from './skills-page-view'
import { translate } from '@/i18n/i18n'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from '@/hooks/installed-agent-skills-change-event'
import {
  addShareableSkillResults,
  eligibleShareSkillCount,
  retainedShareableSkillSelection,
  updatedSkillSelection
} from './skill-share-selection'

const EMPTY_SKILLS: DiscoveredSkill[] = []
const NO_FILTERS: SkillsFilterState = {
  query: '',
  sourceKind: 'all',
  agent: 'all'
}

export default function SkillsPage(): React.JSX.Element {
  const closeSkillsPage = useAppStore((s) => s.closeSkillsPage)
  const pendingSkillShareId = useAppStore((s) => s.pendingSkillShareId)
  const clearPendingSkillShare = useAppStore((s) => s.clearPendingSkillShare)
  const pendingSkillsSharedView = useAppStore((s) => s.pendingSkillsSharedView)
  const clearPendingSkillsSharedView = useAppStore((s) => s.clearPendingSkillsSharedView)
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const hostLabel = useSkillDiscoveryHostLabel(runtimeTarget)
  const [result, setResult] = useState<SkillDiscoveryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanError, setScanError] = useState<string | null>(null)
  const [shareSkills, setShareSkills] = useState<DiscoveredSkill[]>([])
  const [selectingShare, setSelectingShare] = useState(false)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set())
  const [installOpen, setInstallOpen] = useState(false)
  const [installLink, setInstallLink] = useState('')
  const [managementOpen, setManagementOpen] = useState(false)
  const [filters, setFilters] = useState<SkillsFilterState>(NO_FILTERS)
  const [view, setView] = useState<SkillsPageView>('skills')
  const ownedShares = useOwnedSkillShares()
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
      const local = runtimeTarget.kind === 'local'
      if (isCurrentScan()) {
        setResult(nextResult)
        setScanError(null)
        setSelectedSkillIds((current) =>
          retainedShareableSkillSelection(current, nextResult.skills, local)
        )
      }
    } catch (error) {
      console.error('Failed to discover skills:', error)
      if (isCurrentScan()) {
        // Why: a failed scan needs to stay on screen with a retry — a toast
        // disappears before the user can act on it.
        setScanError(
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
    const refresh = (): void => void loadSkills()
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, refresh)
  }, [loadSkills])

  useEffect(() => {
    if (pendingSkillsSharedView) {
      setView('shared')
      setFilters(NO_FILTERS)
      clearPendingSkillsSharedView()
    }
  }, [clearPendingSkillsSharedView, pendingSkillsSharedView])

  useEffect(() => {
    if (!pendingSkillShareId) {
      return
    }
    setInstallLink(`https://app.orca.dev/skills/share/${pendingSkillShareId}`)
    setInstallOpen(true)
    clearPendingSkillShare()
  }, [clearPendingSkillShare, pendingSkillShareId])

  const exitSelection = useCallback((): void => {
    setSelectingShare(false)
    setSelectedSkillIds(new Set())
  }, [])

  // Why: the search box is shared between the two lists, but a link query means
  // nothing against skill names and vice versa.
  const exitSharedLinks = useCallback((): void => {
    setView('skills')
    setFilters(NO_FILTERS)
  }, [])

  const openSharedLinks = useCallback((): void => {
    setView('shared')
    setFilters(NO_FILTERS)
  }, [])

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
        if (element.closest('[data-skills-page-list="true"]')) {
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
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      ) {
        return
      }
      event.preventDefault()
      // Why: leaving the page would silently discard a selection that can hold
      // dozens of skills, so Escape backs out of the mode first.
      if (selectingShare) {
        exitSelection()
        return
      }
      // Why: shared links are a view within the page, so Escape returns to the
      // skill list before it leaves the page.
      if (view === 'shared') {
        exitSharedLinks()
        return
      }
      closeSkillsPage()
    }

    // Why: tooltips can consume Escape before bubble listeners see it. Capture
    // keeps page-level back navigation reliable when no overlay is active.
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeSkillsPage, exitSelection, exitSharedLinks, selectingShare, view])

  const skills = result?.skills ?? EMPTY_SKILLS
  const local = runtimeTarget?.kind === 'local'
  const agentByRootPath = useMemo(() => skillAgentByRootPath(result), [result])
  const agentOptions = useMemo(() => skillAgentOptions(result), [result])
  const visibleSkills = useMemo(
    () => filterSkills(skills, filters, agentByRootPath),
    [agentByRootPath, filters, skills]
  )
  const sourceCounts = useMemo(() => countSkillsBySource(skills), [skills])
  const sourceEntries = useMemo(() => summarizeSkillSources(result), [result])
  const eligibleCount = eligibleShareSkillCount(visibleSkills, local)
  const openInstallDialog = (): void => {
    setInstallLink('')
    setInstallOpen(true)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      {selectingShare ? (
        <SkillsSelectionHeader
          selectedCount={selectedSkillIds.size}
          eligibleCount={eligibleCount}
          onSelectAll={() =>
            setSelectedSkillIds((current) =>
              addShareableSkillResults(current, skills, visibleSkills, local)
            )
          }
          onClear={() => setSelectedSkillIds(new Set())}
          onCancel={exitSelection}
          onShare={() => setShareSkills(skills.filter((skill) => selectedSkillIds.has(skill.id)))}
        />
      ) : (
        <SkillsPageHeader
          skillCount={skills.length}
          sourceEntries={sourceEntries}
          scannedSourceCount={scannedSkillSourceCount(sourceEntries)}
          hostLabel={hostLabel}
          onClose={closeSkillsPage}
          onStartShare={() => {
            setSelectingShare(true)
            setSelectedSkillIds(new Set())
          }}
          onInstallFromLink={openInstallDialog}
          onManageInstalls={() => setManagementOpen(true)}
          onOpenSharedLinks={openSharedLinks}
        />
      )}
      <SkillsFilterToolbar
        view={view}
        filters={filters}
        agentOptions={agentOptions}
        sourceCounts={sourceCounts}
        totalCount={skills.length}
        resultCount={visibleSkills.length}
        linkCount={ownedShares.shares.length}
        loading={view === 'shared' ? ownedShares.loading : loading}
        onViewChange={(next) => (next === 'shared' ? openSharedLinks() : exitSharedLinks())}
        onFiltersChange={setFilters}
        onRefresh={() => (view === 'shared' ? ownedShares.refresh() : void loadSkills())}
      />
      {scanError ? (
        <SkillsScanErrorBand
          message={scanError}
          disabled={loading}
          onRetry={() => void loadSkills()}
        />
      ) : null}

      <section className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <div className={cn(SKILLS_PAGE_COLUMN, 'py-2')} data-skills-page-list="true">
          {view === 'shared' ? (
            <SkillSharedLinksView query={filters.query} shares={ownedShares} />
          ) : (
            <>
              {hostLabel && !local ? <SkillsRemoteShareNotice hostLabel={hostLabel} /> : null}
              {loading && skills.length === 0 ? (
                <SkillsListSkeleton />
              ) : visibleSkills.length > 0 ? (
                <SkillsList
                  skills={visibleSkills}
                  allSkills={skills}
                  local={local}
                  agentByRootPath={agentByRootPath}
                  selectedIds={selectedSkillIds}
                  selectionMode={selectingShare}
                  onSelectedChange={(skillId, selected) =>
                    setSelectedSkillIds((current) =>
                      updatedSkillSelection(current, skillId, selected)
                    )
                  }
                  onSelectResults={(results) =>
                    setSelectedSkillIds((current) =>
                      addShareableSkillResults(current, skills, results, local)
                    )
                  }
                  onShare={(skill) => setShareSkills([skill])}
                />
              ) : skills.length > 0 ? (
                <SkillsNoMatchesState onClearFilters={() => setFilters(NO_FILTERS)} />
              ) : (
                <SkillsEmptyState
                  onRefresh={() => void loadSkills()}
                  onInstallFromLink={openInstallDialog}
                />
              )}
            </>
          )}
        </div>
      </section>

      <SkillShareDialog
        skills={shareSkills}
        open={shareSkills.length > 0}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setShareSkills([])
            exitSelection()
          }
        }}
      />
      <SkillInstallDialog
        key={installLink || 'manual-install'}
        open={installOpen}
        initialLink={installLink}
        onOpenChange={(next) => {
          setInstallOpen(next)
          if (!next) {
            setInstallLink('')
          }
        }}
      />
      <SkillInstallManagementDialog open={managementOpen} onOpenChange={setManagementOpen} />
    </main>
  )
}
