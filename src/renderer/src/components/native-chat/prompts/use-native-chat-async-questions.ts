import { useNativeChatPaneLifetimeEffect } from '../pane/ownership/native-chat-pane-lifetime'
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react'
import {
  isNativeChatViewTabOpenAnywhere,
  NativeChatViewTabContext
} from '../pane/ownership/native-chat-view-memory'
import {
  aggregateAsyncQuestions,
  newestShownAsyncQuestionRow,
  scanPendingAsks
} from '../../../../../shared/native-chat/input/native-chat-ask'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatPromptDismissals as dismissals } from './native-chat-prompt-dismissals'
import { shownStructuredAgentSessionAsyncQuestions } from '../../../../../shared/agent-session/view/structured-agent-session-async-questions'
import type { StructuredAgentSessionAsyncQuestionSkip } from './use-structured-agent-session-async-question-skip'
import { projectionBesideStreamedText } from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

// Skips a released view left behind, by tab, so closing the tab sweeps them; a rewind leaves old scopes, so few are kept.
const KEPT_ASYNC_SCOPES_PER_TAB = 8
const keptAsyncScopesByTab = new Map<string, Set<string>>()

function keepAsyncScopeForTab(tabId: string, scopeKey: string): void {
  if (dismissals.readAsync(scopeKey).size === 0) {
    return
  }
  const scopes = keptAsyncScopesByTab.get(tabId) ?? new Set<string>()
  scopes.delete(scopeKey)
  scopes.add(scopeKey)
  for (const stale of [...scopes].slice(0, Math.max(0, scopes.size - KEPT_ASYNC_SCOPES_PER_TAB))) {
    scopes.delete(stale)
    dismissals.forgetAsync(stale)
  }
  keptAsyncScopesByTab.set(tabId, scopes)
}

export function forgetNativeChatAsyncSkipsForTabs(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    keptAsyncScopesByTab.get(tabId)?.forEach((scopeKey) => dismissals.forgetAsync(scopeKey))
    keptAsyncScopesByTab.delete(tabId)
  }
}

export function useNativeChatAsyncQuestions({
  paneKey,
  sourceKey,
  sourceScope,
  viewKey,
  messages,
  settled,
  queuedTexts,
  skip
}: {
  paneKey: string
  sourceKey: string
  sourceScope: string
  viewKey: string | null
  messages: readonly NativeChatMessage[]
  settled: boolean
  /** Texts waiting in the chat's queue; one quoting a question holds it as answered. */
  queuedTexts?: readonly string[]
  /** The host's saved Skip, on a host that keeps one for every device. */
  skip?: StructuredAgentSessionAsyncQuestionSkip
}) {
  const viewTab = useContext(NativeChatViewTabContext)
  const scopeKey = viewTab
    ? JSON.stringify([viewTab.tabId, paneKey, sourceKey])
    : `${paneKey}:async:${sourceKey}`
  const owner = useMemo(() => ({ scopeKey, viewKey }), [scopeKey, viewKey])
  const active = useRef<object | null>(null)
  useLayoutEffect(() => {
    active.current = owner
    return () => {
      active.current = null
    }
  }, [owner])
  // A released view of an open tab keeps its skips, a tab moved to another workspace included; closing the tab sweeps them with the tab's other dismissals.
  useNativeChatPaneLifetimeEffect(
    useCallback(
      () => () => {
        if (viewTab && isNativeChatViewTabOpenAnywhere(viewTab)) {
          keepAsyncScopeForTab(viewTab.tabId, scopeKey)
        } else {
          dismissals.forgetAsync(scopeKey)
        }
      },
      [scopeKey, viewTab]
    )
  )
  const hidden = useSyncExternalStore(dismissals.subscribe, () => dismissals.readAsync(scopeKey))
  // Asks are tool calls and answers are sends, so a streamed reply's text revision keeps the scan.
  const structure = projectionBesideStreamedText(messages)
  const scan = useMemo(() => (settled ? scanPendingAsks(structure) : null), [structure, settled])
  const skippedThrough = skip?.skippedThrough
  const awaiting = skip?.awaiting
  const contributors = useMemo(
    () =>
      shownStructuredAgentSessionAsyncQuestions(
        scan?.contributors ?? [],
        settled ? structure : null,
        {
          awaiting,
          skippedThrough
        }
      ),
    [scan, awaiting, settled, structure, skippedThrough]
  )
  const prompt = useMemo(
    () => aggregateAsyncQuestions(contributors, sourceScope, hidden, queuedTexts),
    [contributors, sourceScope, hidden, queuedTexts]
  )
  const save = skip?.save
  const dismiss = useCallback(() => {
    if (active.current !== owner) {
      return
    }
    const ids = prompt?.occurrenceIds ?? []
    dismissals.hideAsync(scopeKey, ids)
    const newest = newestShownAsyncQuestionRow(contributors, sourceScope, prompt)
    // A Skip the host did not save shows its card again, as the status still waits on it.
    if (save && newest) {
      void save(newest).catch(() => dismissals.forgetAsync(scopeKey, ids))
    }
  }, [owner, scopeKey, prompt, contributors, sourceScope, save])
  return {
    prompt,
    answerPending: scan?.answerPending === true,
    blocking: scan?.blocking ?? null,
    dismiss,
    ownerKey: JSON.stringify([scopeKey, viewKey])
  }
}
