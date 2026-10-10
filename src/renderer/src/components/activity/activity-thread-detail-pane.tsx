import React from 'react'
import { MessageSquareText, TerminalSquare } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { EventRepoBadge, ThreadAgentStateIndicator } from './activity-thread-controls'
import type { ActivityTerminalPortalSlotId, AgentPaneThread } from './activity-thread-types'

export function ActivityThreadDetailPane({
  selectedThread,
  selectedHasLiveTab,
  selectedWorktreeAvailable,
  visibleThread,
  stagedThread,
  activePortalSlotId,
  setPrimaryPortalTarget,
  setSecondaryPortalTarget,
  visiblePortalReady,
  visiblePortalUnavailable,
  showTerminalLoadingLabel,
  visibleThreadCount
}: {
  selectedThread: AgentPaneThread | null
  selectedHasLiveTab: boolean
  selectedWorktreeAvailable: boolean
  visibleThread: AgentPaneThread | null
  stagedThread: AgentPaneThread | null
  activePortalSlotId: ActivityTerminalPortalSlotId
  setPrimaryPortalTarget: (target: HTMLElement | null) => void
  setSecondaryPortalTarget: (target: HTMLElement | null) => void
  visiblePortalReady: boolean
  visiblePortalUnavailable: boolean
  showTerminalLoadingLabel: boolean
  visibleThreadCount: number
}): React.JSX.Element {
  return (
    <section className="min-w-0 flex-1 overflow-hidden">
      {selectedThread ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* Why (no header action button): per-card hover actions (Mark unread, Open) are the primary controls now, so the header keeps just the thread identity. */}
          <div className="flex shrink-0 items-start gap-4 border-b border-border px-4 pt-2 pb-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-start gap-2">
                <span className="inline-flex shrink-0 items-start gap-1">
                  <ThreadAgentStateIndicator thread={selectedThread} />
                  <span className="inline-flex shrink-0 pt-[3px]">
                    <AgentIcon agent={agentTypeToIconAgent(selectedThread.agentType)} size={16} />
                  </span>
                </span>
                <h2 className="line-clamp-3 break-words text-sm font-semibold leading-snug">
                  {selectedThread.paneTitle}
                </h2>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-11">
                <EventRepoBadge repo={selectedThread.repo} />
                <span className="truncate text-xs text-muted-foreground">
                  {selectedThread.worktree.displayName}
                </span>
              </div>
            </div>
          </div>
          {/* Why: Terminal stays mounted in the hidden workspace tree; this target moves that existing TerminalPane here instead of spawning a second PTY/xterm owner. */}
          {(() => {
            // Why: retained threads can outlive their tab; portal needs a live TerminalPane to render into.
            if (!selectedHasLiveTab) {
              return (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                  <TerminalSquare className="size-7" />
                  {selectedWorktreeAvailable
                    ? translate(
                        'auto.components.activity.ActivityPrototypePage.afdc2139a8',
                        'Agent terminal closed. Open a new terminal in this workspace to continue.'
                      )
                    : translate(
                        'auto.components.activity.ActivityPrototypePage.22b22034bc',
                        'Standalone terminal unavailable in Activity.'
                      )}
                </div>
              )
            }
            return (
              <div className="relative min-h-0 flex-1 overflow-hidden bg-editor-surface">
                <div
                  ref={setPrimaryPortalTarget}
                  className={cn(
                    'absolute inset-0 min-h-0 min-w-0',
                    activePortalSlotId === 'primary'
                      ? 'z-10 opacity-100'
                      : 'pointer-events-none z-0 opacity-0'
                  )}
                  aria-hidden={activePortalSlotId !== 'primary'}
                  data-activity-terminal-slot-id="primary"
                />
                <div
                  ref={setSecondaryPortalTarget}
                  className={cn(
                    'absolute inset-0 min-h-0 min-w-0',
                    activePortalSlotId === 'secondary'
                      ? 'z-10 opacity-100'
                      : 'pointer-events-none z-0 opacity-0'
                  )}
                  aria-hidden={activePortalSlotId !== 'secondary'}
                  data-activity-terminal-slot-id="secondary"
                />
                {visibleThread && !stagedThread && !visiblePortalReady ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-20 bg-editor-surface"
                    aria-hidden="true"
                  >
                    {visiblePortalUnavailable ? (
                      <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                        <span className="h-3 w-1.5 rounded-sm bg-muted-foreground/70" />
                        <span>
                          {translate(
                            'auto.components.activity.ActivityPrototypePage.8de7c5beaa',
                            'Terminal unavailable'
                          )}
                        </span>
                      </div>
                    ) : showTerminalLoadingLabel ? (
                      <div className="ml-3 mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-xs">
                        <span className="h-3 w-1.5 animate-pulse rounded-sm bg-muted-foreground/70" />
                        <span>
                          {translate(
                            'auto.components.activity.ActivityPrototypePage.1b633f5c1e',
                            'Connecting terminal...'
                          )}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })()}
        </div>
      ) : (
        <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          {visibleThreadCount === 0 ? (
            <>
              <MessageSquareText className="size-7" />
              {translate(
                'auto.components.activity.ActivityPrototypePage.e3db9892f6',
                'No activity yet.'
              )}
            </>
          ) : (
            <>
              <TerminalSquare className="size-7" />
              {translate(
                'auto.components.activity.ActivityPrototypePage.cf780197a1',
                'Select an agent to view its activity'
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
