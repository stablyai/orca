import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConversationKnowledgeGraphPreview } from '@/components/conversation-knowledge-graph-preview'
import { ConversationKnowledgeMap } from '@/components/conversation-knowledge-map'
import {
  consumeConversationKnowledgeItem,
  selectConversationKnowledgeItem
} from '@/lib/conversation-knowledge-selection'
import { useAppStore } from '@/store'
import { useActiveWorktree, useAllWorktrees } from '@/store/selectors'
import { buildConversationKnowledgeGraph } from '../../../../shared/conversation-knowledge-graph'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import { translate } from '@/i18n/i18n'
import {
  conversationKnowledgeItemsInGraph,
  scopeConversationKnowledgeGraphToProject,
  searchConversationKnowledgeGraph,
  withoutConversationKnowledgeNotes
} from '@/lib/conversation-knowledge-graph-filter'
import {
  readConversationKnowledgeViewMode,
  writeConversationKnowledgeViewMode,
  type ConversationKnowledgeViewMode
} from '@/lib/conversation-knowledge-view-mode'
import type {
  ConversationKnowledgeIndexStatus,
  ConversationKnowledgeItem
} from '../../../../shared/conversation-knowledge-items'
import { useTranslation } from 'react-i18next'
import { ConversationKnowledgeDetail } from './ConversationKnowledgeDetail'
import { ConversationKnowledgeConceptDetail } from './ConversationKnowledgeConceptDetail'
import { ConversationKnowledgeNoteDetail } from './ConversationKnowledgeNoteDetail'
import { ConversationKnowledgeIndexProgress } from './ConversationKnowledgeIndexProgress'
import {
  ConversationKnowledgeGraphModeSwitch,
  type ConversationKnowledgeGraphMode
} from './ConversationKnowledgeGraphModeSwitch'
import { ConversationKnowledgeResizeHandle } from './ConversationKnowledgeResizeHandle'
import { useConversationKnowledgeDetailResize } from './use-conversation-knowledge-detail-resize'

const IDLE_STATUS: ConversationKnowledgeIndexStatus = {
  state: 'idle',
  total: 0,
  completed: 0,
  failed: 0
}

export default function ConversationKnowledgePanel({
  onClose
}: {
  onClose?: () => void
}): React.JSX.Element {
  useTranslation()
  const settings = useAppStore((state) => state.settings)
  const repos = useAppStore((state) => state.repos)
  const activeWorktree = useActiveWorktree()
  const worktrees = useAllWorktrees()
  const [items, setItems] = useState<ConversationKnowledgeItem[]>([])
  const [selected, setSelected] = useState<ConversationKnowledgeItem | null>(null)
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [status, setStatus] = useState<ConversationKnowledgeIndexStatus>(IDLE_STATUS)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [graphMode, setGraphMode] = useState<ConversationKnowledgeGraphMode>('map')
  const [highlightEvidenceId, setHighlightEvidenceId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ConversationKnowledgeViewMode>(() =>
    typeof window === 'undefined' ? 'all' : readConversationKnowledgeViewMode(window.localStorage)
  )
  const activeProjectId = activeWorktree?.repoId ?? null
  const {
    containerRef: detailPanelRef,
    isResizing: isDetailPanelResizing,
    onResizeStart: onDetailPanelResizeStart
  } = useConversationKnowledgeDetailResize()
  const generatorAgent = settings?.conversationKnowledgeEnrichmentAgent ?? null
  const generatorModel = useMemo(
    () =>
      settings?.conversationKnowledgeEnrichmentModel ??
      (generatorAgent ? getCommitMessageAgentSpec(generatorAgent)?.defaultModelId : null),
    [generatorAgent, settings?.conversationKnowledgeEnrichmentModel]
  )
  const scopePaths = undefined
  const summaryLanguage = typeof navigator === 'undefined' ? 'en' : navigator.language
  const fullGraph = useMemo(
    () => buildConversationKnowledgeGraph({ repos, worktrees, items }),
    [items, repos, worktrees]
  )
  const scopedGraph = useMemo(
    () =>
      viewMode === 'project'
        ? scopeConversationKnowledgeGraphToProject(fullGraph, activeProjectId)
        : fullGraph,
    [activeProjectId, fullGraph, viewMode]
  )
  const visibleGraph = useMemo(
    () => searchConversationKnowledgeGraph(scopedGraph, searchQuery),
    [scopedGraph, searchQuery]
  )
  const auditGraph = useMemo(() => withoutConversationKnowledgeNotes(visibleGraph), [visibleGraph])
  const scopedItems = useMemo(() => conversationKnowledgeItemsInGraph(scopedGraph), [scopedGraph])
  const visibleItems = useMemo(
    () => conversationKnowledgeItemsInGraph(visibleGraph),
    [visibleGraph]
  )
  const visibleSelected =
    visibleItems.find((item) => item.id === selected?.id) ?? visibleItems[0] ?? null
  const selectedConcept =
    visibleGraph.nodes.find((node) => node.id === selectedConceptId && node.type === 'concept') ??
    null
  const selectedNote =
    visibleGraph.nodes.find((node) => node.id === selectedNoteId && node.type === 'note') ?? null

  const refreshKnowledge = useCallback(async () => {
    try {
      const [result, nextStatus] = await Promise.all([
        window.api.aiVault.listKnowledge({ scopePaths }),
        window.api.aiVault.getKnowledgeIndexStatus()
      ])
      setItems(result.items)
      setSelected(
        (current) => result.items.find((item) => item.id === current?.id) ?? result.items[0] ?? null
      )
      setStatus(nextStatus)
      setLoadError(null)
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : translate('conversationKnowledge.error.load', 'Could not load generated knowledge.')
      )
    }
  }, [scopePaths])

  const startIndex = useCallback(
    async (force = false) => {
      if (!generatorAgent || !generatorModel) {
        return
      }
      try {
        const nextStatus = await window.api.aiVault.startKnowledgeIndex({
          generatorAgent,
          generatorModel,
          scopePaths,
          force,
          language: summaryLanguage
        })
        setStatus(nextStatus)
        setLoadError(null)
      } catch (error) {
        setLoadError(
          error instanceof Error
            ? error.message
            : translate('conversationKnowledge.error.start', 'Could not start knowledge indexing.')
        )
      }
    },
    [generatorAgent, generatorModel, scopePaths, summaryLanguage]
  )

  const stopIndex = useCallback(async () => {
    try {
      await window.api.aiVault.cancelKnowledgeIndex()
      await refreshKnowledge()
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : translate('conversationKnowledge.error.stop', 'Could not stop knowledge indexing.')
      )
    }
  }, [refreshKnowledge])

  useEffect(() => {
    void refreshKnowledge()
    const selectPending = (): void => {
      const item = consumeConversationKnowledgeItem()
      if (item) {
        setSelected(item)
      }
    }
    selectPending()
    window.addEventListener('orca:conversation-knowledge-select', selectPending)
    return () => window.removeEventListener('orca:conversation-knowledge-select', selectPending)
  }, [refreshKnowledge])

  useEffect(() => {
    if (status.state !== 'running') {
      return
    }
    const timer = window.setInterval(() => {
      void refreshKnowledge()
    }, 1_200)
    return () => window.clearInterval(timer)
  }, [refreshKnowledge, status.state])

  useEffect(() => {
    if (status.state === 'running' && generatorAgent && generatorModel) {
      void startIndex(false)
    }
  }, [generatorAgent, generatorModel, startIndex, status.state])

  const chooseItem = (item: ConversationKnowledgeItem): void => {
    selectConversationKnowledgeItem(item)
    setSelected(item)
    setSelectedConceptId(null)
    setSelectedNoteId(null)
    setHighlightEvidenceId(null)
  }

  const chooseViewMode = (mode: ConversationKnowledgeViewMode): void => {
    setViewMode(mode)
    writeConversationKnowledgeViewMode(window.localStorage, mode)
  }

  return (
    <div className="@container/conversation-knowledge flex min-h-0 flex-1 flex-col bg-transparent">
      <header className="flex items-start gap-3 border-b border-border p-3">
        <div className="shrink-0">
          <h1 className="text-sm font-medium">
            {translate('conversationKnowledge.name', 'Conversation Knowledge')}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {translate(
              'conversationKnowledge.description',
              'AI-generated topics, conclusions, and relationships from agent history.'
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {scopedItems.length
              ? translate(
                  'conversationKnowledge.items.count',
                  'Showing {{visible}} of {{total}} items',
                  { visible: visibleItems.length, total: scopedItems.length }
                )
              : translate('conversationKnowledge.items.empty', 'No knowledge items')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ConversationKnowledgeGraphModeSwitch value={graphMode} onChange={setGraphMode} />
            <ToggleGroup
              type="single"
              variant="compact"
              size="xs"
              spacing={1}
              value={viewMode}
              onValueChange={(value) => {
                if (value === 'all' || value === 'project') {
                  chooseViewMode(value)
                }
              }}
              className="h-7"
              aria-label={translate(
                'conversationKnowledge.scope.ariaLabel',
                'Knowledge graph scope'
              )}
            >
              {(['all', 'project'] as const).map((mode) => (
                <ToggleGroupItem key={mode} value={mode}>
                  {mode === 'all'
                    ? translate('conversationKnowledge.scope.all', 'All')
                    : translate('conversationKnowledge.scope.project', 'By project')}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="relative w-40 max-w-full">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                className="h-6"
                variant="denseSearch"
                aria-label={translate(
                  'conversationKnowledge.search.ariaLabel',
                  'Search conversation knowledge'
                )}
                placeholder={translate(
                  'conversationKnowledge.search.placeholder',
                  'Search statements, summaries, or nodes'
                )}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
          </div>
        </div>
        {generatorAgent && generatorModel ? (
          <div className="min-w-0 flex-1">
            <ConversationKnowledgeIndexProgress
              status={status}
              disabled={!generatorAgent || !generatorModel}
              onGenerateUpdates={() => void startIndex(false)}
              onRegenerateAll={() => void startIndex(true)}
              onStop={() => void stopIndex()}
            />
          </div>
        ) : null}
        {onClose ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={onClose}>
                <X />
                <span className="sr-only">
                  {translate('auto.components.ui.sheet.1189e9fe0a', 'Close')}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate('auto.components.ui.sheet.1189e9fe0a', 'Close')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </header>

      {loadError ? (
        <p className="border-b border-border p-3 text-sm text-destructive">{loadError}</p>
      ) : null}
      {!generatorAgent || !generatorModel ? (
        <div className="p-4 text-sm text-muted-foreground">
          {translate(
            'conversationKnowledge.configurationRequired',
            'Choose an enabled summary agent and model in Settings → Experimental → Conversation Knowledge.'
          )}
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-row divide-x divide-y-0 divide-border">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
            <div className="min-h-0 flex-1">
              {graphMode === 'map' ? (
                <ConversationKnowledgeMap
                  graph={visibleGraph}
                  selectedConceptId={selectedConceptId}
                  onSelectConcept={(concept) => {
                    setSelectedConceptId(concept.id)
                    setSelectedNoteId(null)
                  }}
                />
              ) : (
                <ConversationKnowledgeGraphPreview
                  graph={auditGraph}
                  selectedItemId={visibleSelected?.id}
                  onSelectItem={chooseItem}
                  onSelectNode={(node) => {
                    setSelectedConceptId(node.type === 'concept' ? node.id : null)
                    setSelectedNoteId(node.type === 'note' ? node.id : null)
                  }}
                  viewMode={viewMode}
                  projectId={activeProjectId}
                  emptyMessage={
                    searchQuery.trim()
                      ? translate(
                          'conversationKnowledge.empty.search',
                          'No matching summaries or related nodes.'
                        )
                      : translate(
                          'conversationKnowledge.empty.generated',
                          'No generated knowledge yet.'
                        )
                  }
                />
              )}
            </div>
          </div>
          <div ref={detailPanelRef} className="relative min-h-0 min-w-0 flex-none">
            <ConversationKnowledgeResizeHandle
              isResizing={isDetailPanelResizing}
              onResizeStart={onDetailPanelResizeStart}
            />
            <ScrollArea className="h-full min-h-0 min-w-0">
              {selectedNote ? (
                <ConversationKnowledgeNoteDetail
                  note={selectedNote}
                  graph={visibleGraph}
                  onSelectItem={chooseItem}
                />
              ) : selectedConcept ? (
                <ConversationKnowledgeConceptDetail
                  concept={selectedConcept}
                  graph={visibleGraph}
                  sourceHistoryScope={viewMode}
                  onSelectItem={chooseItem}
                />
              ) : visibleSelected ? (
                <ConversationKnowledgeDetail
                  item={visibleSelected}
                  highlightEvidenceId={highlightEvidenceId}
                  sourceHistoryScope={viewMode}
                />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {searchQuery.trim()
                    ? translate(
                        'conversationKnowledge.empty.search',
                        'No matching summaries or related nodes.'
                      )
                    : translate(
                        'conversationKnowledge.empty.selection',
                        'Select a topic or summary node to inspect its details and sources.'
                      )}
                </p>
              )}
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  )
}
