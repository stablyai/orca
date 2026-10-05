import { useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PaneSubagentView } from '@/store/slices/ui/ui-slice-contract'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'
import { NativeChatEmptyState } from '../native-chat/NativeChatEmptyState'
import { useNativeChatFileLinkContext } from '../native-chat/use-native-chat-file-link-context'
import { useNativeChatLinkActions } from '../native-chat/use-native-chat-link-actions'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatRetainedSession } from '../native-chat/use-native-chat-retained-session'
import { selectNativeChatViewState } from '../native-chat/native-chat-view-state'
import { selectNativeChatRuntimeEnvironmentId } from '../native-chat/native-chat-runtime-owner'
import {
  runningSubagentChildRowModels,
  subagentActivationTarget
} from '../sidebar/worktree-subagent-child-rows'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { NativeChatPaneCover } from './NativeChatPaneCover'
import { paneShownSubagentTranscriptPath } from './pane-subagent-view-source'
import type { TerminalPaneController } from './use-terminal-pane-controller'

// Agent ids never hold NUL, so this cannot collide with a subagent's value.
const MAIN_AGENT_VALUE = '\u0000main'

/** Covers each pane whose agent's subagent was chosen in the sidebar with that subagent's
 *  read-only transcript; choosing the main agent uncovers the live pane again. */
export function TerminalPaneSubagentViewPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes, tabId, isRendererVisible, nativeChatTranscriptIsLocalReadable } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <PaneSubagentViewPortal
          key={pane.id}
          pane={pane}
          paneKey={makePaneKey(tabId, pane.leafId)}
          terminalTabId={tabId}
          isVisible={isRendererVisible}
          transcriptIsLocalReadable={nativeChatTranscriptIsLocalReadable}
        />
      ))}
    </>
  )
}

function PaneSubagentViewPortal({
  pane,
  paneKey,
  terminalTabId,
  isVisible,
  transcriptIsLocalReadable
}: {
  pane: ManagedPane
  paneKey: string
  terminalTabId: string
  isVisible: boolean
  transcriptIsLocalReadable: boolean
}): React.ReactPortal | null {
  const view = useAppStore((s) => s.paneSubagentViewByPaneKey[paneKey])
  const transcriptPath = useAppStore((s) =>
    paneShownSubagentTranscriptPath(s, paneKey, transcriptIsLocalReadable)
  )
  if (!view || !transcriptPath) {
    return null
  }
  return createPortal(
    <NativeChatPaneCover pane={pane}>
      <PaneSubagentTranscript
        paneKey={paneKey}
        terminalTabId={terminalTabId}
        view={view}
        transcriptPath={transcriptPath}
        isVisible={isVisible}
      />
    </NativeChatPaneCover>,
    pane.container,
    `pane-subagent-view-${pane.id}`
  )
}

function PaneSubagentTranscript({
  paneKey,
  terminalTabId,
  view,
  transcriptPath,
  isVisible
}: {
  paneKey: string
  terminalTabId: string
  view: PaneSubagentView
  transcriptPath: string
  isVisible: boolean
}): React.JSX.Element {
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, terminalTabId)
  )
  const session = useNativeChatRetainedSession({
    // Why: its own key, so the parent's live hook state never reads as the subagent's.
    paneKey: `${paneKey}\u0000subagent-view:${view.agentId}`,
    agent: 'claude',
    // Why: the agent id, not the parent's session id — a missing file must not resolve to the parent.
    sessionId: view.agentId,
    transcriptPath,
    runtimeEnvironmentId,
    enabled: isVisible
  })
  const viewState = selectNativeChatViewState(session)
  const rootRef = useRef<HTMLDivElement>(null)
  // Links open the way they do in the pane's own chat.
  const fileLinkContext = useNativeChatFileLinkContext(terminalTabId)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId: view.agentId, isVisible }
  )
  return (
    <div ref={rootRef} className="flex h-full min-h-0 w-full flex-col bg-background">
      <PaneSubagentSwitcher paneKey={paneKey} view={view} />
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'ready' ? (
          <NativeChatMessageList
            session={session}
            isVisible={isVisible}
            isWorking={viewState.isWorking}
            expandSignal={false}
            fontScale={1}
            onLinkClick={onLinkClick}
            allowFileUriLinks={fileLinkContext !== null}
          />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : (
          // A subagent's transcript appears moments after it starts; until then it is loading.
          <NativeChatEmptyState kind="loading" />
        )}
      </div>
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}

function PaneSubagentSwitcher({
  paneKey,
  view
}: {
  paneKey: string
  view: PaneSubagentView
}): React.JSX.Element {
  const showPaneSubagent = useAppStore((s) => s.showPaneSubagent)
  const showPaneMainAgent = useAppStore((s) => s.showPaneMainAgent)
  const parentEntry = useAppStore((s) => s.agentStatusByPaneKey[paneKey])
  const threads = useMemo(() => {
    // Only ids and names are read here, so freshness does not matter.
    const running = parentEntry ? runningSubagentChildRowModels(parentEntry, true) : []
    const targets = running.flatMap((row) => subagentActivationTarget(row) ?? [])
    // The shown subagent stays choosable after it finishes and leaves the running list.
    return targets.some((target) => target.id === view.agentId)
      ? targets
      : [...targets, { id: view.agentId, name: view.name }]
  }, [parentEntry, view.agentId, view.name])
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-3 py-1.5">
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={view.agentId}
        aria-label={translate('components.terminalPane.subagentView.threads', 'Agent threads')}
        onValueChange={(agentId) => {
          const target = threads.find((thread) => thread.id === agentId)
          // An empty value is the shown item clicked again: stay on it.
          if (agentId === MAIN_AGENT_VALUE) {
            showPaneMainAgent(paneKey)
          } else if (target) {
            showPaneSubagent(paneKey, { agentId: target.id, name: target.name })
          }
        }}
      >
        <ToggleGroupItem value={MAIN_AGENT_VALUE}>
          {translate('components.terminalPane.subagentView.main', 'Main agent')}
        </ToggleGroupItem>
        {threads.map((thread) => (
          <ToggleGroupItem key={thread.id} value={thread.id} title={thread.name}>
            <span className="max-w-48 truncate">{thread.name}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="shrink-0 text-xs text-muted-foreground">
        {translate('components.terminalPane.subagentView.readOnly', 'Read-only transcript')}
      </span>
    </div>
  )
}
