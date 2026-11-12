import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { buildAiVaultCopiedSessionStartupForWorktree } from '@/lib/agent-session/resume/history/ai-vault-session-fork-startup'
import { launchAiVaultSessionAndReveal } from '@/lib/agent-session/resume/history/launch-ai-vault-session-and-reveal'
import { updateNativeChatComposerDraft } from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import type { NativeChatForkOutcome } from './native-chat-fork-launch'

/** The terminal chat a fork copies: its Claude conversation file on the chat's host. */
export type NativeChatTerminalForkSource = {
  sessionId: string
  transcriptPath: string
  worktreeId: string
}

function failure(error: unknown): void {
  toast.error(translate('components.native-chat.fork.terminalFailed', 'Couldn’t fork this chat'), {
    description: error instanceof Error ? error.message : undefined
  })
}

/** Puts `draft` in the new tab's chat composer once its pane exists, and shows the tab as chat. */
function leaveDraftInNewTab(tabId: string, draft: string): void {
  const place = (): boolean => {
    const state = useAppStore.getState()
    const root = state.terminalLayoutsByTabId[tabId]?.root
    let node = root
    while (node && node.type !== 'leaf') {
      node = node.first
    }
    if (!node) {
      return false
    }
    state.setTabViewMode(tabId, 'chat')
    updateNativeChatComposerDraft(`${tabId}:${node.leafId}`, { text: draft }, 'immediate')
    return true
  }
  if (place()) {
    return
  }
  const stop = useAppStore.subscribe(() => {
    if (place()) {
      stop()
    }
  })
  // A tab that never lays out (a failed launch) must not keep a listener alive.
  setTimeout(stop, 30_000)
}

/** Copies the terminal Claude chat through `throughItemId` on its host, into the destination
 *  worktree's project when there is one, and resumes the copy in a new terminal tab there. */
export async function launchNativeChatTerminalFork(input: {
  source: NativeChatTerminalForkSource
  throughItemId: string
  destinationWorktreeId?: string
  draft?: string
}): Promise<NativeChatForkOutcome> {
  const state = useAppStore.getState()
  const worktreeId = input.destinationWorktreeId ?? input.source.worktreeId
  const worktree = state.getKnownWorktreeById(worktreeId)
  // Without the destination's folder the copy would land where Claude in that worktree can't find it.
  if (input.destinationWorktreeId && !worktree) {
    failure(
      new Error(
        translate(
          'components.native-chat.fork.terminalNoWorktree',
          'The new worktree isn’t available yet. Try again.'
        )
      )
    )
    return {}
  }
  const executionHostId =
    getExecutionHostIdForWorktree(state, input.source.worktreeId) ?? LOCAL_EXECUTION_HOST_ID
  try {
    const prepared = await window.api.aiVault.prepareSessionResume({
      agent: 'claude',
      sessionId: input.source.sessionId,
      filePath: input.source.transcriptPath,
      codexHome: null,
      executionHostId,
      fork: true,
      forkThroughEntryId: input.throughItemId,
      ...(input.destinationWorktreeId && worktree ? { destinationCwd: worktree.path } : {})
    })
    const forked = prepared.forkedSession
    if (!forked) {
      throw new Error(
        translate(
          'components.native-chat.fork.terminalHostTooOld',
          'Update Orca on the host that runs this chat, then fork again.'
        )
      )
    }
    const startup = buildAiVaultCopiedSessionStartupForWorktree(
      {
        state,
        worktreeId,
        session: {
          agent: 'claude',
          sessionId: forked.sessionId,
          ...(forked.filePath ? { filePath: forked.filePath } : {}),
          cwd: worktree?.path ?? '',
          codexHome: null,
          executionHostId
        }
      },
      'claude'
    )
    const tabId = await launchAiVaultSessionAndReveal({ agent: 'claude', worktreeId, ...startup })
    if (tabId && input.draft) {
      leaveDraftInNewTab(tabId, input.draft)
    }
  } catch (error) {
    failure(error)
  }
  return {}
}
