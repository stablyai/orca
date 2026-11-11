import React from 'react'
import { Cloud, Play, SquareTerminal } from 'lucide-react'
import type {
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { CloudGitChanges } from '../CloudGitChanges'
import { CloudWorkspaceHeader } from '../CloudWorkspaceHeader'
import { asOfParts } from '../read-snapshot/cloud-read-snapshot-format'
import { CloudReadPrLink } from '../read-snapshot/CloudReadPrLink'
import { ChatPanel } from './CloudOfflineChatPanel'
import { formatAsleepSince } from './CloudAsleepTerminalNotice'
import { tidyTerminalTail } from './tidy-terminal-tail'

export type CloudOfflineViewProps = {
  snapshot: CloudOfflineSnapshot
  queued: CloudQueuedPrompt[]
  workspaceName: string | null
  now: number
  onWake: () => void
  onQueue: (sessionId: string, text: string) => Promise<boolean>
  onCancel: (id: string) => void
  onEdit: (id: string, text: string) => Promise<boolean>
  headingRef?: React.Ref<HTMLHeadingElement>
  /** Sleep chosen here and still running: the status line says so, and Keep awake replaces Wake. */
  goingToSleep?: boolean
  /** Keeps it running instead (the same as opening it again before the sleep ends). */
  onKeepAwake?: () => void
  /** Kept on screen right after Sleep: nothing here wakes it but "Wake to continue". */
  viewOnly?: boolean
}

/** A terminal tail opens at its newest lines, the way the live pane did. */
function scrollToEnd(element: HTMLElement | null): void {
  if (element) {
    element.scrollTop = element.scrollHeight
  }
}

/**
 * A sleeping Orca Cloud workspace, browsable from the client cache without waking it. Waking (the
 * header's Wake, or sending a message) goes through the same wake and "Waking…" overlay as
 * opening the workspace.
 */
export function CloudWorkspaceOfflineView(props: CloudOfflineViewProps): React.JSX.Element {
  const t = useTranslate()
  const { snapshot, now } = props
  const changeCount = snapshot.git?.changeCount ?? 0
  const defaultTab =
    snapshot.chats.length > 0 ? 'chat' : snapshot.terminals.length > 0 ? 'terminals' : 'changes'
  const empty = snapshot.capturedAt === null
  const asOf = snapshot.capturedAt === null ? null : asOfParts(snapshot.capturedAt, now)
  const stateLine = props.goingToSleep
    ? t('orcaCloudWorkspace.state.goingToSleep', 'Going to sleep…')
    : asOf
      ? t('components.orcaCloud.read.asOf', 'Asleep · As of {{when}}', { when: asOf.relative })
      : t('orcaCloudWorkspace.asleep.noCopy', 'Asleep · nothing cached yet')
  // Sections may come from the copy the workspace saved when it went to sleep (Orca Cloud).
  const fromCloud = snapshot.source === 'cloud' || snapshot.source === 'mixed'
  return (
    <section
      className="flex h-full min-h-0 w-full max-w-3xl flex-col gap-5 px-6 py-8"
      aria-label={t('components.orcaCloud.offline.region', 'Asleep workspace (read-only)')}
      data-cloud-offline-view=""
    >
      <CloudWorkspaceHeader
        icon={Cloud}
        title={props.workspaceName ?? t('orcaCloudWorkspace.thisWorkspaceTitle', 'This workspace')}
        state="sleeping"
        stateLine={stateLine}
        stateTitle={asOf?.absolute}
        note={
          empty
            ? undefined
            : // Still saving: the copy shown is the one from before, not the one going to sleep.
              props.goingToSleep
              ? t(
                  'components.orcaCloud.offline.savingCopy',
                  'Saving a read-only copy of chats, terminals and changes…'
                )
              : fromCloud
                ? t('components.orcaCloud.read.note', 'Read-only copy saved when it went to sleep.')
                : t('orcaCloudWorkspace.asleep.readOnly', 'Read-only copy kept on this computer.')
        }
        headingRef={props.headingRef}
        action={
          props.goingToSleep && props.onKeepAwake ? (
            <Button size="sm" onClick={props.onKeepAwake}>
              <Play />
              {t('components.orcaCloud.offline.keepAwake', 'Keep awake')}
            </Button>
          ) : (
            <Button size="sm" onClick={props.onWake}>
              <Play />
              {t('components.orcaCloud.read.wakeToContinue', 'Wake to continue')}
            </Button>
          )
        }
      />
      {empty ? (
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          {props.goingToSleep
            ? t(
                'components.orcaCloud.offline.savingCopy',
                'Saving a read-only copy of chats, terminals and changes…'
              )
            : t(
                'components.orcaCloud.offline.emptyBody',
                'Orca keeps a copy of chats, terminals and changes once you have used this workspace while it was awake.'
              )}
        </p>
      ) : (
        <>
          {snapshot.pr ? <CloudReadPrLink pr={snapshot.pr} /> : null}
          <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="chat">
                {t('components.orcaCloud.offline.tabChat', 'Chat')}
                {snapshot.chats.length > 0 ? (
                  <span className="text-muted-foreground">{snapshot.chats.length}</span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="terminals">
                {t('components.orcaCloud.offline.tabTerminals', 'Terminals')}
                {snapshot.terminals.length > 0 ? (
                  <span className="text-muted-foreground">{snapshot.terminals.length}</span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="changes">
                {t('components.orcaCloud.offline.tabChanges', 'Changes')}
                {changeCount > 0 ? (
                  <span className="text-muted-foreground">{changeCount}</span>
                ) : null}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="chat" className="mt-3 flex min-h-0 flex-1 flex-col">
              <ChatPanel
                chats={snapshot.chats}
                queued={props.queued}
                onQueue={props.onQueue}
                onCancel={props.onCancel}
                onEdit={props.onEdit}
                viewOnly={props.viewOnly}
              />
            </TabsContent>
            <TabsContent value="terminals" className="mt-3 flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
                {snapshot.terminals.length === 0 ? (
                  <p className="max-w-[60ch] py-4 text-sm text-muted-foreground">
                    {t('components.orcaCloud.offline.noTerminals', 'No terminal output was saved.')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {snapshot.terminals.map((terminal, index) => {
                      // The tab's title, else "Terminal N": never the terminal's internal id (RA-13).
                      const title =
                        terminal.title && !terminal.title.startsWith('term_')
                          ? terminal.title
                          : t('components.orcaCloud.offline.terminalN', 'Terminal {{n}}', {
                              n: index + 1
                            })
                      return (
                        <figure
                          key={terminal.handle}
                          className="overflow-hidden rounded-lg border border-border"
                        >
                          <figcaption className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                            <SquareTerminal className="size-3.5" aria-hidden="true" />
                            <span className="truncate">{title}</span>
                            <span className="ml-auto">
                              {t('components.orcaCloud.offline.readOnly', 'Read-only')}
                            </span>
                          </figcaption>
                          <pre
                            // Greyed: this is what it printed before the sleep, not live output (JA-15).
                            className="max-h-72 overflow-auto scrollbar-sleek bg-background px-3 py-2 font-mono text-xs leading-5 text-muted-foreground"
                            tabIndex={0}
                            aria-label={t(
                              'components.orcaCloud.offline.terminalOutput',
                              'Saved output of {{title}}',
                              { title }
                            )}
                            // Like a live terminal, open at the latest output.
                            ref={scrollToEnd}
                          >
                            {tidyTerminalTail(terminal.lines).join('\n')}
                          </pre>
                          {snapshot.capturedAt !== null ? (
                            <div
                              data-cloud-asleep-divider=""
                              className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground"
                            >
                              <span className="h-px flex-1 bg-border" />
                              <span>
                                {t(
                                  'orcaCloudWorkspace.terminal.asleepSince',
                                  'Asleep since {{time}}',
                                  {
                                    time: formatAsleepSince(snapshot.capturedAt)
                                  }
                                )}
                              </span>
                              <span className="h-px flex-1 bg-border" />
                            </div>
                          ) : null}
                        </figure>
                      )
                    })}
                  </div>
                )}
              </div>
            </TabsContent>
            <TabsContent value="changes" className="mt-3 flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
                {snapshot.git ? (
                  <CloudGitChanges
                    now={now}
                    data={{
                      branch: snapshot.git.branch,
                      changes: snapshot.git.changes,
                      changeCount: snapshot.git.changeCount,
                      lineTotals:
                        typeof snapshot.git.added === 'number' &&
                        typeof snapshot.git.removed === 'number'
                          ? { added: snapshot.git.added, removed: snapshot.git.removed }
                          : null,
                      commits: snapshot.git.commits.map((commit) => ({
                        sha: commit.id,
                        subject: commit.subject,
                        at: commit.at
                      }))
                    }}
                  />
                ) : (
                  <p className="max-w-[60ch] py-4 text-sm text-muted-foreground">
                    {t('components.orcaCloud.offline.noGit', 'No source control state was saved.')}
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  )
}
