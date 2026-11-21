import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Activity, Terminal } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { ResourcePtyPanel, type ResourcePtyEndAllConfirmation } from './pty/ResourcePtyPanel'
import React, { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { DaemonActionDialog } from '../../shared/useDaemonActions'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../composition/status-bar-context-menu-policy'
import { useResourceUsageStatusController } from './use-resource-usage-status-controller'
import { renderResourceUsageStatusTrigger } from './popover/resource-usage-status-trigger'
import {
  renderDaemonUnreachableBanner,
  renderResourceUsagePopoverHeader,
  renderResourceUsageSummary,
  renderSessionsOnlyErrorBanner
} from './popover/resource-usage-popover-summary'
import {
  renderResourceUsagePopoverBody,
  renderResourceUsagePopoverFooter
} from './popover/resource-usage-popover-body'
import { renderResourceUsageKillDialog } from './popover/resource-usage-kill-dialog'
import { WorkspaceSpaceCompactPanel } from '../workspace-storage/WorkspaceSpaceCompactPanel'

export function ResourceUsageStatusSegment(): React.JSX.Element {
  const t = useTranslate()
  const controller = useResourceUsageStatusController()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [endAllConfirmation, setEndAllConfirmation] =
    useState<ResourcePtyEndAllConfirmation | null>(null)
  const {
    open,
    setOpen,
    sortOption,
    setSortOption,
    collapsedRepos,
    collapsedWorktrees,
    appCollapsed,
    setAppCollapsed,
    activeWorktreeId,
    killConfirm,
    setKillConfirm,
    killing,
    setPopoverBodyNode,
    daemonActions,
    resourceSnapshot,
    runtimeHostNotices,
    spaceScanReady,
    recordFeatureInteraction,
    unifiedRepos,
    orphanCount,
    triggerSessionCount,
    memoryMetricCopy,
    ownerSplit,
    commitToneClass,
    commitBadgeLabel,
    daemonUnreachable,
    sessionsOnlyError,
    resourceManagerTooltipLines,
    resourceManagerAriaLabel,
    toggleRepo,
    toggleWorktree,
    navigateToWorktree,
    navigateToTab,
    deleteWorktree,
    handleOpenWorkspaceCleanup,
    handleKillSession,
    handleKillOrphans,
    runKillConfirmed,
    openSpaceResults
  } = controller

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          recordFeatureInteraction('resource-manager')
        }
        setOpen(nextOpen)
      }}
    >
      {renderResourceUsageStatusTrigger(
        {
          daemonUnreachable,
          resourceManagerAriaLabel,
          spaceScanReady,
          commitToneClass,
          triggerSessionCount,
          orphanCount,
          resourceManagerTooltipLines
        },
        t
      )}

      <PopoverContent
        ref={popoverRef}
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="flex h-[min(40rem,var(--radix-popover-content-available-height))] w-[26rem] max-w-[calc(100vw-2rem)] flex-col"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Why: activating a tab focuses xterm's DOM node; Radix would read that as focus-outside and close. Outside-click and Escape still close.
        onFocusOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (killConfirm || endAllConfirmation) {
            event.preventDefault()
          }
        }}
      >
        {renderResourceUsagePopoverHeader(
          {
            daemonActions,
            onRefresh:
              controller.selectedTab === 'ptys'
                ? () => void controller.localPtyInventory.refreshSessions()
                : controller.refreshResources
          },
          t
        )}
        <Tabs
          value={controller.selectedTab}
          onValueChange={controller.setSelectedTab}
          className="min-h-0 flex-1"
        >
          <div className="shrink-0 px-3 pt-1 pb-1">
            <TabsList variant="line" size="sm">
              <TabsTrigger value="resources">
                <Activity aria-hidden="true" className="size-3" />
                {t('resourceManager.resources', 'Resources')}
              </TabsTrigger>
              <TabsTrigger value="ptys">
                <Terminal aria-hidden="true" className="size-3" />
                {t('resourceManager.ptys', 'PTYs')}
                {controller.localPtyInventory.observedAt !== null && (
                  <Badge variant="secondary">
                    {controller.localPtyInventory.sessionInventory.count}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="resources"
            className="flex min-h-0 flex-col data-[state=inactive]:hidden"
          >
            {controller.actionError && (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {controller.actionError}
              </p>
            )}
            {daemonUnreachable && renderDaemonUnreachableBanner({ daemonActions }, t)}
            {!daemonUnreachable && sessionsOnlyError && renderSessionsOnlyErrorBanner(t)}
            {ownerSplit && (
              <div className="min-h-0 max-h-[40%] overflow-y-auto scrollbar-sleek">
                {renderResourceUsageSummary(
                  {
                    ownerSplit,
                    commitBadgeLabel,
                    commitToneClass,
                    orphanCount
                  },
                  t
                )}
              </div>
            )}
            {renderResourceUsagePopoverBody(
              {
                setPopoverBodyNode,
                unifiedRepos,
                resourceSnapshot,
                sortOption,
                setSortOption,
                memoryMetricCopy,
                collapsedRepos,
                toggleRepo,
                collapsedWorktrees,
                activeWorktreeId,
                toggleWorktree,
                navigateToWorktree,
                navigateToTab,
                deleteWorktree,
                handleKillSession,
                appCollapsed,
                setAppCollapsed,
                daemonUnreachable,
                runtimeHostNotices
              },
              t
            )}
            {renderResourceUsagePopoverFooter(
              {
                handleOpenWorkspaceCleanup,
                orphanCount,
                handleKillOrphans
              },
              t
            )}
            <WorkspaceSpaceCompactPanel onOpenFullPage={openSpaceResults} />
          </TabsContent>
          <TabsContent value="ptys" className="min-h-0 data-[state=inactive]:hidden">
            <ResourcePtyPanel
              active={controller.ptyViewActive}
              inventory={controller.localPtyInventory}
              actions={controller.ptyActions}
              bindings={controller.ptySessionBindings}
              worktrees={controller.allWorktrees}
              repos={controller.repos}
              projectGroups={controller.projectGroups}
              runtimePaneTitlesByTabId={controller.runtimePaneTitlesByTabId}
              liveTabs={controller.resourceSessionBindings.tabsByWorktree}
              onNavigate={navigateToTab}
              onConfirmEndAll={setEndAllConfirmation}
            />
          </TabsContent>
        </Tabs>
      </PopoverContent>
      {/* Why: hoisted to a sibling of PopoverContent — nested, the Dialog unmounts with the popover mid-interaction and the kill-confirm flow disappears. */}
      {renderResourceUsageKillDialog(
        {
          killConfirm,
          setKillConfirm,
          killing,
          runKillConfirmed
        },
        t
      )}
      <Dialog
        open={endAllConfirmation !== null}
        onOpenChange={(next) => {
          if (!next) {
            setEndAllConfirmation(null)
          }
        }}
      >
        <DialogContent
          size="confirm"
          initialFocus="cancel"
          className="z-[80]"
          overlayClassName="z-[80]"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            popoverRef.current
              ?.querySelector<HTMLElement>('[data-resource-pty-body]')
              ?.focus({ preventScroll: true })
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t('resourceManager.pty.endAllConfirmTitle', 'End all terminals?')}
            </DialogTitle>
            <DialogDescription>
              {!!endAllConfirmation?.runningCount && (
                <>
                  {t(
                    'resourceManager.pty.endAllRunningCount',
                    '{{count}} sessions are running agents or other programs.',
                    {
                      count: endAllConfirmation.runningCount,
                      defaultValue_one: '{{count}} session is running an agent or another program.'
                    }
                  )}{' '}
                </>
              )}
              {!!endAllConfirmation?.unverifiableCount && (
                <>
                  {t(
                    'resourceManager.pty.endAllUnverifiableCount',
                    "Couldn't check for running work in {{count}} terminals.",
                    {
                      count: endAllConfirmation.unverifiableCount,
                      defaultValue_one: "Couldn't check for running work in {{count}} terminal."
                    }
                  )}{' '}
                </>
              )}
              {t(
                'resourceManager.pty.endAllConfirmWarning',
                'Ending these terminals stops their processes and can lose unsaved work.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogCancel />
            <Button
              variant="destructive"
              size="sm"
              disabled={controller.localPtyInventory.sessionsError}
              onClick={() => {
                if (endAllConfirmation) {
                  setEndAllConfirmation(null)
                  void controller.ptyActions.endMany(endAllConfirmation.rows)
                }
              }}
            >
              {t('resourceManager.pty.endAll', 'End all')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DaemonActionDialog api={daemonActions} />
    </Popover>
  )
}
