import { useEffect, useState } from 'react'
import { BrowserFavicon } from '@/components/browser-favicon'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findPage } from '@/store/slices/browser-page-records'
import { findBrowserWorkspaceForRemotePage } from '@/runtime/web-session-tabs-sync/mirrored-browser-tabs'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import {
  getBrowserAgentActivityRevision,
  useLastBrowserAgentActivity
} from '../browser-pane/agent-cursor/browser-agent-activity-state'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import { nativeChatToolRunCategory } from '../../../../shared/native-chat/tools/native-chat-tool-icon'
import { nativeChatFullCommand } from '../../../../shared/native-chat/tools/native-chat-tool-input-text'
import { parseOrcaBrowserCommand } from '../../../../shared/orca-browser-cli-commands'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'

// Without `--page` a run only knows the worktree's latest agent page, so each run keeps the
// page it first resolved to instead of following later runs to newer pages.
const pageIdByRunCallId = new Map<string, string>()
const REMEMBERED_RUNS_MAX = 500

/** Reveals the page a run of agent browser commands used; nothing for any other run. */
export function NativeChatBrowserRunPageButton({
  calls
}: {
  calls: readonly NativeChatToolCallBlock[]
}): React.JSX.Element | null {
  if (nativeChatToolRunCategory(calls) !== 'browser') {
    return null
  }
  const lastCall = calls.at(-1)
  const lastCommand = nativeChatFullCommand(lastCall?.input) ?? ''
  return (
    <BrowserPageButton
      pageId={parseOrcaBrowserCommand(lastCommand)?.pageId ?? null}
      runCallId={lastCall?.callId ?? null}
    />
  )
}

function BrowserPageButton({
  pageId,
  runCallId
}: {
  /** The page the command named with `--page`; otherwise the worktree's agent page. */
  pageId: string | null
  runCallId: string | null
}): React.JSX.Element | null {
  const owner = useNativeChatVisualOwner()
  const latest = useLastBrowserAgentActivity(owner?.worktreeId ?? null)
  // A call appears before its command reaches the browser, so only later activity is its own.
  const [baseline, setBaseline] = useState(() => ({
    runCallId,
    revision: getBrowserAgentActivityRevision()
  }))
  if (baseline.runCallId !== runCallId) {
    setBaseline({ runCallId, revision: getBrowserAgentActivityRevision() })
  }
  const ownActivityPageId = latest && latest.revision > baseline.revision ? latest.pageId : null
  const rememberedPageId = runCallId ? pageIdByRunCallId.get(runCallId) : undefined
  const targetPageId = pageId ?? rememberedPageId ?? latest?.pageId ?? null
  useEffect(() => {
    if (!runCallId || pageId || rememberedPageId || !ownActivityPageId) {
      return
    }
    pageIdByRunCallId.set(runCallId, ownActivityPageId)
    if (pageIdByRunCallId.size > REMEMBERED_RUNS_MAX) {
      const oldest = pageIdByRunCallId.keys().next().value
      if (oldest !== undefined) {
        pageIdByRunCallId.delete(oldest)
      }
    }
  }, [runCallId, pageId, rememberedPageId, ownActivityPageId])
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
      aria-label={translate('components.native-chat.tool.showBrowserPageLabel', 'Show {{value0}}', {
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
      {translate('components.native-chat.tool.showBrowserPage', 'Show')}
    </button>
  )
}
