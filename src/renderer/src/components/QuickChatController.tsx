import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  startQuickChat,
  showQuickChatFailure,
  type QuickChatDestination
} from '@/lib/start-quick-chat'
import { QuickChatIntents, type QuickChatIntent } from '@/lib/quick-chat-intents'
import { QUICK_CHAT_EVENT, QUICK_CHAT_ANCHOR_EVENT } from '@/lib/quick-chat-events'
import { isWebClientLocation } from '@/lib/web-client-location'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { requestNativeChatComposerFocus } from './native-chat/use-native-chat-composer-reveal-focus'
import { useNewTabAgentMenuRows } from './tab-bar/use-new-tab-agent-menu-rows'
import { ProjectedAgentMenuItems, useTabAgentMenuLaunch } from './tab-bar/QuickLaunchButton'
import { useAgentLaunchPickerInventory } from './agent/use-agent-launch-picker-inventory'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'

const QuickChatObservation = memo(function QuickChatObservation({
  repoId,
  worktreeId,
  intents
}: QuickChatDestination & { intents: QuickChatIntents }) {
  const [repo, worktree] = useAppStore(
    useShallow(
      (state) =>
        [
          state.repos.find(
            (row) => row.id === repoId && getRepoExecutionHostId(row) === LOCAL_EXECUTION_HOST_ID
          ),
          selectWorktreesByRepo(state)[repoId]?.find(
            (row) => row.id === worktreeId && row.hostId === LOCAL_EXECUTION_HOST_ID
          )
        ] as const
    )
  )
  const resolvedTarget = useMemo(
    () => (repo && worktree ? { repo, worktree } : undefined),
    [repo, worktree]
  )
  const context = useAppStore((state) =>
    resolvedTarget
      ? getLocalAgentPreflightContext(state, undefined, undefined, resolvedTarget)
      : undefined
  )
  const detection = useMemo(
    (): AgentDetectionTarget | undefined =>
      resolvedTarget
        ? {
            kind: 'local',
            worktreeId,
            resolvedTarget,
            contextKey: localAgentInventoryContextKey(context)
          }
        : undefined,
    [resolvedTarget, worktreeId, context]
  )
  const target = useMemo(
    () => ({
      workspace: { kind: workspaceKindForWorktreeId(worktreeId), worktreeId, resolvedTarget }
    }),
    [worktreeId, resolvedTarget]
  )
  const model = useNewTabAgentMenuRows(target, true, detection)
  // The launcher derives the active group after local activation, which can replace a twin's layout.
  const launch = useTabAgentMenuLaunch({
    worktreeId,
    groupId: '',
    onFocusTerminal: focusTerminalTabSurface,
    onFocusChat: requestNativeChatComposerFocus
  })
  useSyncExternalStore(intents.subscribe, intents.snapshot, intents.snapshot)
  const head = intents.pending.values().next().value
  const matches = (intent: QuickChatIntent) =>
    intent.destination?.worktreeId === worktreeId && intent.destination.repoId === repoId
  const first = head && matches(head) ? head : undefined
  const entries = useAgentLaunchPickerInventory(worktreeId, model, Boolean(first))
  const current = useRef({ model, first, entries })
  useLayoutEffect(() => {
    current.current = { model, first, entries }
  })
  const launchIntent = (intent: QuickChatIntent, ...args: Parameters<typeof launch>) => {
    if (
      !first ||
      !intents.live(intent) ||
      model.state !== 'settled' ||
      current.current.model !== model ||
      current.current.first !== first ||
      current.current.entries !== entries
    ) {
      return
    }
    // A click from an obsolete picker cannot launch with a different runtime or owner.
    const state = useAppStore.getState()
    const currentRepo = state.repos.find(
      (row) => row.id === repoId && getRepoExecutionHostId(row) === LOCAL_EXECUTION_HOST_ID
    )
    const currentWorktree = selectWorktreesByRepo(state)[repoId]?.find(
      (row) => row.id === worktreeId && row.hostId === LOCAL_EXECUTION_HOST_ID
    )
    const currentContext =
      currentRepo && currentWorktree
        ? getLocalAgentPreflightContext(state, undefined, undefined, {
            repo: currentRepo,
            worktree: currentWorktree
          })
        : undefined
    if (!currentRepo || !currentWorktree || currentContext !== context) {
      return
    }
    try {
      intents.transition(intent, () => {
        if (
          activateAndRevealWorktree(worktreeId, {
            executionHostId: LOCAL_EXECUTION_HOST_ID,
            providesInitialSurface: true
          }) === false
        ) {
          showQuickChatFailure()
          return
        }
        launch(...args)
      })
    } catch {
      showQuickChatFailure()
    } finally {
      intents.finish(intent)
    }
  }
  const runLaunch: typeof launch = (...args) => {
    if (first) {
      launchIntent(first, ...args)
    }
  }
  useEffect(() => {
    if (!first) {
      return
    }
    if (!resolvedTarget) {
      showQuickChatFailure()
      for (const intent of intents.pending.values()) {
        if (matches(intent)) {
          intents.finish(intent)
        }
      }
      return
    }
    if (model.state !== 'settled') {
      return
    }
    const row = model.rows.find((row) => row.kind === 'chat' && row.agent === model.defaultTuiAgent)
    if (row) {
      intents.transition(first, () => {
        for (const intent of intents.pending.values()) {
          if (!matches(intent)) {
            break
          }
          launchIntent(intent, row)
        }
      })
    }
  })
  if (!first || model.state !== 'settled' || !first.anchor) {
    return null
  }
  const defaultRow = model.rows.some(
    (row) => row.kind === 'chat' && row.agent === model.defaultTuiAgent
  )
  return (
    <DropdownMenu
      key={first.id}
      open={!defaultRow}
      onOpenChange={(open) => {
        if (!open && intents.live(first)) {
          if (first.control?.isConnected) {
            first.control.focus()
          }
          intents.finish(first)
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed"
          style={{
            top: first.anchor.top,
            left: first.anchor.left,
            width: first.anchor.width,
            height: first.anchor.height
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <ProjectedAgentMenuItems model={model} runLaunch={runLaunch} pickerEntries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

function mountedAnchor() {
  return (
    document.querySelector<HTMLButtonElement>('[data-quick-chat="sidebar"]') ??
    document.querySelector<HTMLButtonElement>('[data-quick-chat="landing"]') ??
    undefined
  )
}

export function QuickChatController() {
  const [intents] = useState(() => new QuickChatIntents())
  useSyncExternalStore(intents.subscribe, intents.snapshot, intents.snapshot)
  useEffect(() => {
    const start = (event: Event) => {
      if (isWebClientLocation() || !(event instanceof CustomEvent)) {
        return
      }
      const { id, control } = event.detail
      if (typeof id !== 'string' || (control !== undefined && !(control instanceof HTMLElement))) {
        return
      }
      const intent = intents.accept(id, control)
      if (!control) {
        const mounted = mountedAnchor()
        if (mounted) {
          intents.anchor(mounted, intent)
        }
      }
      const state = useAppStore.getState()
      if (!control && (state.activeView !== 'terminal' || !state.sidebarOpen)) {
        intents.transition(intent, () => {
          state.setActiveView('terminal')
          state.setSidebarOpen(true)
        })
      }
      void startQuickChat().then((destination) => {
        if (!intents.live(intent)) {
          return
        }
        if (!destination) {
          intents.finish(intent)
          return
        }
        intent.destination = destination
        intents.changed()
      })
    }
    const anchor = (event: Event) => {
      if (event instanceof CustomEvent) {
        intents.anchor(event.detail instanceof HTMLElement ? event.detail : mountedAnchor())
      }
    }
    window.addEventListener(QUICK_CHAT_EVENT, start)
    window.addEventListener(QUICK_CHAT_ANCHOR_EVENT, anchor)
    return () => {
      window.removeEventListener(QUICK_CHAT_EVENT, start)
      window.removeEventListener(QUICK_CHAT_ANCHOR_EVENT, anchor)
      intents.dispose()
    }
  }, [intents])
  const destination = intents.pending.values().next().value?.destination
  return destination ? <QuickChatObservation {...destination} intents={intents} /> : null
}
