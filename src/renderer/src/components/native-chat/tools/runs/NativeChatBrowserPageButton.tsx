import { useEffect, useState, useSyncExternalStore } from 'react'
import { BrowserFavicon } from '@/components/browser-favicon'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { findPage } from '@/store/slices/browser/pages/browser-page-records'
import { findBrowserWorkspaceForRemotePage } from '@/runtime/web-session-tabs-sync/mirrored-browser-tabs'
import { activateBrowserPagePaletteResult } from '@/lib/browser/palette/browser-page-palette-activation'
import { useLastBrowserAgentPageId } from '../../../browser-pane/agent-cursor/browser-agent-activity-state'
import {
  useNativeChatVisualOwner,
  type NativeChatVisualOwner
} from '../../media/visuals/native-chat-visual-owner'
import { findStructuredAgentSessionReadOwner } from '../../session/structured/read/structured-agent-session-read-owner-registry'
import {
  nativeChatToolCategory,
  nativeChatToolRunCategory
} from '../../../../../../shared/native-chat/tools/native-chat-tool-icon'
import { nativeChatFullCommand } from '../../../../../../shared/native-chat/tools/native-chat-tool-input-text'
import { parseOrcaBrowserCommand } from '../../../../../../shared/orca-browser-cli-commands'
import type { NativeChatToolCallBlock } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

// A run's page outlives the run only here: no transcript records the page a command without
// `--page` drove, so a run seen while it was the chat's latest keeps that page in this renderer.
const pageIdByRunCallId = new Map<string, string>()
const REMEMBERED_RUNS_MAX = 500

function commandPageId(call: NativeChatToolCallBlock | undefined): string | null {
  return parseOrcaBrowserCommand(nativeChatFullCommand(call?.input) ?? '')?.pageId ?? null
}

/** The page the run's newest call named or was remembered with. */
function rememberedRunPageId(calls: readonly NativeChatToolCallBlock[]): string | null {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]
    const pageId = commandPageId(call) ?? (call.callId ? pageIdByRunCallId.get(call.callId) : null)
    if (pageId) {
      return pageId
    }
  }
  return null
}

const latestBrowserCallIdByItems = new WeakMap<readonly AgentJournalRenderItem[], string | null>()

function latestBrowserCallId(items: readonly AgentJournalRenderItem[]): string | null {
  const cached = latestBrowserCallIdByItems.get(items)
  if (cached !== undefined) {
    return cached
  }
  let callId: string | null = null
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const { body, itemId } = items[index]
    if (
      body.kind === 'tool-call' &&
      nativeChatToolCategory(body.name, body.mcpIdentity, body.input) === 'browser'
    ) {
      // The same identity structuredAgentSessionToolCallBlock gives the rendered call.
      callId = body.callId ?? itemId
      break
    }
  }
  latestBrowserCallIdByItems.set(items, callId)
  return callId
}

const NO_READ_OWNER = (): (() => void) => () => {}

/** The chat's newest browser call: its agent's browser activity is that call's run's. */
function useLatestBrowserCallId(owner: NativeChatVisualOwner | null): string | null {
  const readOwner = owner
    ? findStructuredAgentSessionReadOwner(owner.sessionId, owner.target)
    : undefined
  const read = (): string | null => {
    const snapshot = readOwner?.getSnapshot()
    // A transcript behind the host may lack the newer call that drove the latest activity.
    return snapshot?.current ? latestBrowserCallId(snapshot.state.items) : null
  }
  return useSyncExternalStore(readOwner?.subscribe ?? NO_READ_OWNER, read, read)
}

/** Reveals the page a run of agent browser commands used; nothing for any other run. */
export function NativeChatBrowserRunPageButton({
  calls
}: {
  calls: readonly NativeChatToolCallBlock[]
}): React.JSX.Element | null {
  if (nativeChatToolRunCategory(calls) !== 'browser') {
    return null
  }
  return <BrowserPageButton calls={calls} />
}

function BrowserPageButton({
  calls
}: {
  calls: readonly NativeChatToolCallBlock[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const owner = useNativeChatVisualOwner()
  const lastCall = calls.at(-1)
  const runCallId = lastCall?.callId ?? null
  const latestPageId = useLastBrowserAgentPageId(
    owner?.worktreeId ?? null,
    owner?.sessionId ?? null
  )
  const isLatestRun = useLatestBrowserCallId(owner) === runCallId && runCallId !== null
  // Why: state, not a render-time Map read, so React Compiler's caches see the remembered page.
  const [run, setRun] = useState(() => ({ runCallId, pageId: rememberedRunPageId(calls) }))
  if (run.runCallId !== runCallId) {
    setRun({ runCallId, pageId: rememberedRunPageId(calls) })
  }
  // Only the chat's newest browser run owns its agent's latest activity; older runs keep theirs.
  const activityPageId = isLatestRun ? latestPageId : null
  if (run.runCallId === runCallId && activityPageId && run.pageId !== activityPageId) {
    setRun({ runCallId, pageId: activityPageId })
  }
  const rememberedPageId = run.runCallId === runCallId ? run.pageId : null
  // Why: a run that can't name its page shows nothing rather than another run's page.
  const targetPageId = commandPageId(lastCall) ?? rememberedPageId
  useEffect(() => {
    if (!runCallId || !rememberedPageId || pageIdByRunCallId.get(runCallId) === rememberedPageId) {
      return
    }
    pageIdByRunCallId.set(runCallId, rememberedPageId)
    if (pageIdByRunCallId.size > REMEMBERED_RUNS_MAX) {
      const oldest = pageIdByRunCallId.keys().next().value
      if (oldest !== undefined) {
        pageIdByRunCallId.delete(oldest)
      }
    }
  }, [runCallId, rememberedPageId])
  const page = useAppStore((state) => {
    if (!targetPageId) {
      return null
    }
    const localPage = findPage(state.browserPagesByWorkspace, targetPageId)
    if (localPage || owner?.target.kind !== 'environment') {
      return localPage
    }
    // A remote runtime's `--page` names its own page id, which a local handle maps.
    return (
      findBrowserWorkspaceForRemotePage(
        state,
        owner.worktreeId,
        owner.target.environmentId,
        targetPageId
      )?.page ?? null
    )
  })
  if (!page) {
    return null
  }
  const title = page.title || page.url
  return (
    <button
      type="button"
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={title}
      aria-label={t('components.native-chat.tool.showBrowserPageLabel', 'Show {{value0}}', {
        value0: title
      })}
      onClick={() =>
        activateBrowserPagePaletteResult({
          pageId: page.id,
          workspaceId: page.workspaceId,
          worktreeId: page.worktreeId
        })
      }
    >
      <BrowserFavicon faviconUrl={page.faviconUrl} className="size-3.5" />
      {t('components.native-chat.tool.showBrowserPage', 'Show')}
    </button>
  )
}
