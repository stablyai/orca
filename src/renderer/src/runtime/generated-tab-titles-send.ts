import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { afterLayoutFrame } from '@/runtime/layout-frame-position'
import { refusalActsAsToday, type WindowRefusalCode } from '@/runtime/layout-apply-send'
import { errorMessage } from '../../../shared/error-message'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'

/** One tab's agent-generated title, for `sendGeneratedTabTitles`. */
export type GeneratedTitleSend = { worktreeId: string; tabId: string; title: string | null }

/**
 * Agent-generated titles, of any workspaces, in one `layout.apply`: main renames them in one write,
 * then, once the window has that frame, `answer` names each title to show (as `sendLayoutApply`'s
 * apply or asToday would). Returns, per title, whether main was asked; a title it was not asked
 * for (a paired server owns the workspace's layout) is the caller's to show, and is not shown.
 */
export function sendGeneratedTabTitles(
  state: Parameters<typeof runtimeEnvironmentIdUnlessTwin>[0],
  titles: readonly GeneratedTitleSend[],
  answer: (shown: boolean[]) => void
): boolean[] {
  const sent = titles.map(({ worktreeId }) => !runtimeEnvironmentIdUnlessTwin(state, worktreeId))
  const renames = titles.flatMap(({ worktreeId, tabId, title }, index) =>
    sent[index] ? [{ workspace: worktreeId, tabId, title }] : []
  )
  if (renames.length === 0) {
    return sent
  }
  /** The reply's refusal of one title; undefined when main gave it. */
  const refusalOf = (reply: LayoutApplyReply, { worktreeId, tabId }: GeneratedTitleSend) =>
    reply.ok
      ? reply.result.untitled?.find(
          (entry) => entry.workspace === worktreeId && entry.tabId === tabId
        )?.code
      : reply.code
  const answerAll = (reply: LayoutApplyReply | null, error?: unknown): void => {
    const refused = new Set<WindowRefusalCode>()
    const shown = titles.map((title, index) => {
      if (!sent[index]) {
        return false
      }
      const code = reply ? refusalOf(reply, title) : 'call_failed'
      if (code === undefined || refusalActsAsToday(state, title.worktreeId, code)) {
        return true
      }
      refused.add(code)
      return false
    })
    if (refused.size > 0) {
      const failure = reply ? [] : [errorMessage(error)]
      console.warn('[layout-owner] renameTabs refused:', [...refused].join(', '), ...failure)
    }
    answer(shown)
  }
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: { type: 'renameTabs', kind: 'generated', renames }
  })
    .then(
      (reply) => afterLayoutFrame(reply.frameSeq, () => answerAll(reply)),
      (error: unknown) => answerAll(null, error)
    )
    .catch((error: unknown) => {
      console.warn('[layout-owner] renameTabs handler threw:', errorMessage(error))
    })
  return sent
}
