import React from 'react'
import { Minus, Plus, Trash, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import {
  getDiscardAllPaths,
  getUnstageAllPaths,
  isStageableStatusEntry,
  type DiscardAllArea
} from '../commit/discard-all-sequence'
import { ActionButton } from './action-button'
import { SectionHeader } from './section-header'
import { SourceControlSectionFileList } from './section-file-list'
import {
  getSourceControlSectionViewAction,
  type SourceControlDisplaySection,
  type SourceControlDisplaySectionId,
  type SourceControlSectionArea,
  type SourceControlSectionViewAction
} from './section-order'
import type {
  RenderableSourceControlNode,
  RenderableSubmoduleListItem
} from './submodule-expansion'
import type { SourceControlRowOpenEvent } from './split-open'

const SECTION_LABELS: Record<SourceControlSectionArea, { key: string; fallback: string }> = {
  staged: {
    key: 'auto.components.right.sidebar.SourceControl.48a003c1b1',
    fallback: 'Staged Changes'
  },
  unstaged: {
    key: 'auto.components.right.sidebar.SourceControl.d4ef4bafc5',
    fallback: 'Changes'
  },
  untracked: {
    key: 'auto.components.right.sidebar.SourceControl.522f44dce5',
    fallback: 'Untracked Files'
  }
}
const CONFLICTS_SECTION_LABEL = {
  key: 'auto.components.right.sidebar.SourceControl.conflictsSection',
  fallback: 'Conflicts'
}

export function SourceControlUncommittedSections(props: {
  displaySections: SourceControlDisplaySection[]
  unfilteredDisplaySectionsById: ReadonlyMap<
    SourceControlDisplaySectionId,
    SourceControlDisplaySection
  >
  normalizedFilter: string
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
  onViewSection: (action: SourceControlSectionViewAction) => void
  isExecutingBulk: boolean
  requestDiscardAllInArea: (area: DiscardAllArea, paths?: readonly string[]) => void
  handleStageAllPaths: (paths: readonly string[]) => Promise<void>
  handleUnstagePaths: (paths: readonly string[]) => Promise<void>
  sourceControlViewMode: SourceControlViewMode
  visibleTreeRowsBySection: Partial<
    Record<SourceControlDisplaySectionId, RenderableSourceControlNode[]>
  >
  visibleListRowsBySection: Partial<
    Record<SourceControlDisplaySectionId, RenderableSubmoduleListItem[]>
  >
  fileListScrollElement: HTMLDivElement | null
  collapsedTreeDirs: Set<string>
  toggleTreeDir: (key: string) => void
  requestDiscardPaths: (area: DiscardAllArea, paths: readonly string[]) => void
  expandedSubmoduleKeys: Set<string>
  toggleSubmodule: (entry: Pick<GitStatusEntry, 'area' | 'path'>) => void
  currentWorktreeId: string
  worktreePath: string
  selectedKeySet: ReadonlySet<string>
  activeOpenRowKeys: ReadonlySet<string>
  handleSelect: (event: React.MouseEvent, key: string, entry: GitStatusEntry) => void
  handleContextMenu: (key: string) => void
  revealInExplorer: (worktreeId: string, absolutePath: string) => void
  activeConnectionId: string | null
  handleOpenDiff: (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => void
  handleStage: (path: string) => Promise<void>
  handleUnstage: (path: string) => Promise<void>
  requestDiscardEntry: (entry: GitStatusEntry) => void
  diffCommentCountByPath: Map<string, number>
}): React.JSX.Element {
  return (
    <>
      {props.displaySections.map((section) => {
        const { area, id, items } = section
        const isCollapsed = props.collapsedSections.has(id)
        // Why: bulk stage/unstage act on the *unfiltered* group; the +/- hides while filtering to avoid acting on more than what's shown.
        // Why: visibility and execution resolve paths via the same eligibility rules, so the button never shows for a set the handler would filter to empty.
        const actionSection = props.unfilteredDisplaySectionsById.get(id) ?? section
        const actionItems = actionSection.items
        const stageAllPaths = actionItems.filter(isStageableStatusEntry).map((entry) => entry.path)
        const unstageAllPaths = getUnstageAllPaths(actionItems)
        const discardAllPaths = getDiscardAllPaths(actionItems, area)
        const canStageAll = !props.normalizedFilter && stageAllPaths.length > 0
        const canUnstageAll = !props.normalizedFilter && unstageAllPaths.length > 0
        const canRevertAll = !props.normalizedFilter && discardAllPaths.length > 0
        const sectionLabel = id === 'conflicts' ? CONFLICTS_SECTION_LABEL : SECTION_LABELS[area]
        const sectionViewAction = getSourceControlSectionViewAction(actionSection)
        return (
          <div key={id}>
            <SectionHeader
              label={translate(sectionLabel.key, sectionLabel.fallback)}
              count={items.length}
              conflictCount={items.filter((entry) => entry.conflictStatus === 'unresolved').length}
              isCollapsed={isCollapsed}
              onToggle={() => props.toggleSection(id)}
              actions={
                <>
                  {/* Why: bulk actions are hover-only, but forced visible on no-hover pointers (touch/SSH; see AGENTS.md "SSH Use Case"). One wrapper so focusing any action reveals all three (else keyboard tabs into an invisible stop). */}
                  <div className="flex items-center can-hover:opacity-0 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100">
                    {canRevertAll && (
                      <ActionButton
                        icon={area === 'untracked' ? Trash : Undo2}
                        title={
                          area === 'untracked'
                            ? translate(
                                'auto.components.right.sidebar.SourceControl.2f609a2e7c',
                                'Delete all untracked'
                              )
                            : translate(
                                'auto.components.right.sidebar.SourceControl.ce41708855',
                                'Discard all'
                              )
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          props.requestDiscardAllInArea(area, discardAllPaths)
                        }}
                        disabled={props.isExecutingBulk}
                      />
                    )}
                    {canStageAll && (
                      <ActionButton
                        icon={Plus}
                        title={translate(
                          'auto.components.right.sidebar.SourceControl.24d2598eff',
                          'Stage all'
                        )}
                        onClick={(event) => {
                          event.stopPropagation()
                          void props.handleStageAllPaths(stageAllPaths)
                        }}
                        disabled={props.isExecutingBulk}
                      />
                    )}
                    {canUnstageAll && (
                      <ActionButton
                        icon={Minus}
                        title={translate(
                          'auto.components.right.sidebar.SourceControl.9339382454',
                          'Unstage all'
                        )}
                        onClick={(event) => {
                          event.stopPropagation()
                          void props.handleUnstagePaths(unstageAllPaths)
                        }}
                        disabled={props.isExecutingBulk}
                      />
                    )}
                  </div>
                  {sectionViewAction ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={
                        items.some((entry) => entry.conflictStatus === 'unresolved')
                          ? 'h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground'
                          : 'h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'
                      }
                      onClick={(event) => {
                        event.stopPropagation()
                        props.onViewSection(sectionViewAction)
                      }}
                    >
                      {translate(
                        'auto.components.right.sidebar.SourceControl.48db37cca9',
                        'View all'
                      )}
                    </Button>
                  ) : null}
                </>
              }
            />
            {!isCollapsed && (
              <SourceControlSectionFileList
                treeRows={props.visibleTreeRowsBySection[id] ?? []}
                listRows={props.visibleListRowsBySection[id] ?? []}
                sourceControlViewMode={props.sourceControlViewMode}
                fileListScrollElement={props.fileListScrollElement}
                normalizedFilter={props.normalizedFilter}
                isExecutingBulk={props.isExecutingBulk}
                collapsedTreeDirs={props.collapsedTreeDirs}
                toggleTreeDir={props.toggleTreeDir}
                requestDiscardPaths={props.requestDiscardPaths}
                handleStageAllPaths={props.handleStageAllPaths}
                handleUnstagePaths={props.handleUnstagePaths}
                expandedSubmoduleKeys={props.expandedSubmoduleKeys}
                toggleSubmodule={props.toggleSubmodule}
                currentWorktreeId={props.currentWorktreeId}
                worktreePath={props.worktreePath}
                selectedKeySet={props.selectedKeySet}
                activeOpenRowKeys={props.activeOpenRowKeys}
                handleSelect={props.handleSelect}
                handleContextMenu={props.handleContextMenu}
                revealInExplorer={props.revealInExplorer}
                activeConnectionId={props.activeConnectionId}
                handleOpenDiff={props.handleOpenDiff}
                handleStage={props.handleStage}
                handleUnstage={props.handleUnstage}
                requestDiscardEntry={props.requestDiscardEntry}
                diffCommentCountByPath={props.diffCommentCountByPath}
              />
            )}
          </div>
        )
      })}
    </>
  )
}
