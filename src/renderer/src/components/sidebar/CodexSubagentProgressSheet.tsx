import { Loader2, MessageSquare, TriangleAlert } from 'lucide-react'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { NativeChatMessageList } from '@/components/native-chat/NativeChatMessageList'
import { selectNativeChatViewState } from '@/components/native-chat/native-chat-view-state'
import { useNativeChatLiveSession } from '@/components/native-chat/use-native-chat-live-session'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { resolveCodexSubagentProgressRoute } from './codex-subagent-progress-route'
import {
  parseCodexSubagentProgressTarget,
  type CodexSubagentProgressTarget
} from './codex-subagent-progress-target'

type ProgressPlaceholderKind = 'loading' | 'empty' | 'error'

function asDotState(state: AgentStatusState | 'idle'): AgentDotState {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
  }
}

function ProgressPlaceholder({
  kind,
  message
}: {
  kind: ProgressPlaceholderKind
  message?: string
}): React.JSX.Element {
  const copy =
    kind === 'loading'
      ? {
          title: translate(
            'components.codex-subagent-progress.loading.title',
            'Waiting for subagent output…'
          ),
          subtitle: translate(
            'components.codex-subagent-progress.loading.subtitle',
            'New messages, reasoning, and tool activity will appear here as Codex writes them.'
          )
        }
      : kind === 'empty'
        ? {
            title: translate(
              'components.codex-subagent-progress.empty.title',
              'No transcript entries'
            ),
            subtitle: translate(
              'components.codex-subagent-progress.empty.subtitle',
              'This subagent did not write any visible messages or tool activity.'
            )
          }
        : {
            title: translate(
              'components.codex-subagent-progress.error.title',
              'Subagent progress unavailable'
            ),
            subtitle:
              message ??
              translate(
                'components.codex-subagent-progress.error.subtitle',
                'The subagent transcript could not be read.'
              )
          }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      aria-live="polite"
    >
      <div
        className={
          kind === 'error'
            ? 'flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive'
            : 'flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground'
        }
      >
        {kind === 'loading' ? (
          <Loader2 className="size-6 animate-spin" />
        ) : kind === 'error' ? (
          <TriangleAlert className="size-6" />
        ) : (
          <MessageSquare className="size-6" />
        )}
      </div>
      <p className="text-sm font-medium text-foreground">{copy.title}</p>
      <p className="max-w-sm text-balance text-xs text-muted-foreground">{copy.subtitle}</p>
    </div>
  )
}

function unavailableMessage(
  reason: 'unknown-owner' | 'legacy-ssh' | 'runtime-owner-missing'
): string {
  switch (reason) {
    case 'legacy-ssh':
      return translate(
        'components.codex-subagent-progress.unavailable.legacy-ssh',
        'Live subagent transcripts are not available for legacy SSH workspaces.'
      )
    case 'runtime-owner-missing':
      return translate(
        'components.codex-subagent-progress.unavailable.runtime-owner-missing',
        'The remote runtime owner is not available yet. Reopen this view after the workspace reconnects.'
      )
    case 'unknown-owner':
      return translate(
        'components.codex-subagent-progress.unavailable.unknown-owner',
        'Orca could not determine which host owns this subagent transcript.'
      )
  }
}

function CodexSubagentTranscript({
  target,
  state,
  runtimeEnvironmentId
}: {
  target: CodexSubagentProgressTarget
  state: AgentStatusState | 'idle'
  runtimeEnvironmentId: string | null
}): React.JSX.Element {
  const session = useNativeChatLiveSession({
    paneKey: target.paneKey,
    agent: 'codex',
    sessionId: target.sessionId,
    runtimeEnvironmentId
  })
  const viewState = selectNativeChatViewState(session)
  const working = state === 'working' || session.status === 'working'

  if (viewState.kind === 'error') {
    return <ProgressPlaceholder kind="error" message={viewState.message} />
  }
  if (viewState.kind === 'loading' || (working && session.messages.length === 0)) {
    return <ProgressPlaceholder kind="loading" />
  }
  if (viewState.kind === 'empty') {
    return <ProgressPlaceholder kind="empty" />
  }
  return (
    <NativeChatMessageList
      session={session}
      isWorking={working}
      expandSignal={false}
      fontScale={1}
    />
  )
}

function CodexSubagentProgressBody({
  target
}: {
  target: CodexSubagentProgressTarget
}): React.JSX.Element {
  const parentEntry = useAppStore((state) => state.agentStatusByPaneKey[target.parentPaneKey])
  const liveSubagent = parentEntry?.subagents?.find((subagent) => subagent.id === target.sessionId)
  const route = resolveCodexSubagentProgressRoute(target.hostAuthority)
  const state = liveSubagent?.state ?? 'idle'
  const dotState = asDotState(state)
  const label = liveSubagent?.description?.trim() || target.label
  const model = liveSubagent?.model?.trim() || target.model

  return (
    <>
      <SheetHeader className="border-b border-border pr-12">
        <div className="flex min-w-0 items-center gap-2">
          <AgentStateDot state={dotState} size="md" />
          <SheetTitle className="min-w-0 truncate" title={label}>
            {label}
          </SheetTitle>
          <Badge variant="secondary">
            {translate('components.codex-subagent-progress.read-only', 'Read only')}
          </Badge>
        </div>
        <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {translate(
              'components.codex-subagent-progress.description',
              'Codex subagent transcript'
            )}
          </span>
          <span aria-hidden>·</span>
          <span>{agentStateLabel(dotState)}</span>
          {model ? (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono text-xs">{model}</span>
            </>
          ) : null}
        </SheetDescription>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {route.kind === 'readable' ? (
          <CodexSubagentTranscript
            target={target}
            state={state}
            runtimeEnvironmentId={route.runtimeEnvironmentId}
          />
        ) : (
          <ProgressPlaceholder kind="error" message={unavailableMessage(route.reason)} />
        )}
      </div>
    </>
  )
}

export default function CodexSubagentProgressSheet(): React.JSX.Element {
  const activeModal = useAppStore((state) => state.activeModal)
  const modalData = useAppStore((state) => state.modalData)
  const closeModal = useAppStore((state) => state.closeModal)
  const target = parseCodexSubagentProgressTarget(modalData)
  const open = activeModal === 'codex-subagent-progress'

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeModal()
        }
      }}
    >
      <SheetContent className="w-full p-0 sm:max-w-2xl" data-codex-subagent-progress="">
        {target ? (
          <CodexSubagentProgressBody target={target} />
        ) : (
          <>
            <SheetTitle className="sr-only">
              {translate('components.codex-subagent-progress.title', 'Codex subagent progress')}
            </SheetTitle>
            <ProgressPlaceholder kind="error" />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
