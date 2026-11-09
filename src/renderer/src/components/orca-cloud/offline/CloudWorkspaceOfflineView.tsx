import React from 'react'
import { Moon, Play, SquareTerminal } from 'lucide-react'
import type {
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { formatRelative } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { CloudGitChanges } from '../CloudGitChanges'
import { CloudWorkspaceHeader } from '../CloudWorkspaceHeader'
import { ChatPanel } from './CloudOfflineChatPanel'

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
  const stateLine = empty
    ? t('orcaCloudWorkspace.asleep.noCopy', 'Asleep · nothing cached yet')
    : t('orcaCloudWorkspace.asleep.copyFrom', 'Asleep · copy from {{when}}', {
        when: formatRelative(snapshot.capturedAt!, now)
      })
  return (
    <section
      className="flex h-full min-h-0 w-full max-w-3xl flex-col gap-5 px-6 py-8"
      aria-label={t('components.orcaCloud.offline.region', 'Sleeping workspace (read-only)')}
      data-cloud-offline-view=""
    >
      <CloudWorkspaceHeader
        icon={Moon}
        title={props.workspaceName ?? t('orcaCloudWorkspace.thisWorkspaceTitle', 'This workspace')}
        state="sleeping"
        stateLine={stateLine}
        note={
          empty
            ? undefined
            : t('orcaCloudWorkspace.asleep.readOnly', 'Read-only copy kept on this computer.')
        }
        headingRef={props.headingRef}
        action={
          <Button size="sm" onClick={props.onWake}>
            <Play />
            {t('components.orcaCloud.offline.wake', 'Wake')}
          </Button>
        }
      />
      {empty ? (
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          {t(
            'components.orcaCloud.offline.emptyBody',
            'Orca keeps a copy of chats, terminals and changes once you have used this workspace while it was awake.'
          )}
        </p>
      ) : (
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
                  {snapshot.terminals.map((terminal) => {
                    const title = terminal.title ?? terminal.handle
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
                          className="max-h-72 overflow-auto scrollbar-sleek bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground/90"
                          tabIndex={0}
                          aria-label={t(
                            'components.orcaCloud.offline.terminalOutput',
                            'Saved output of {{title}}',
                            { title }
                          )}
                          // Like a live terminal, open at the latest output.
                          ref={scrollToEnd}
                        >
                          {terminal.lines.join('\n')}
                        </pre>
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
      )}
    </section>
  )
}
