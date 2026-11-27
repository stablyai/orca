import { Card } from '@/components/ui/card'
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import {
  readStartupDraftSnapshot,
  startupDraftRpc,
  subscribeStartupDraftSnapshot,
  watchLocalStartupDrafts
} from '@/lib/workspace/creation/worktree-startup-draft-recovery'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { AvailableStartupDraft } from '../../../../shared/worktree/creation/startup-draft-receipt'
import { StartupDraftFields } from './StartupDraftFields'

export const StartupDraftRecoveryPanel = memo(function StartupDraftRecoveryPanel({
  visible
}: {
  visible: boolean
}) {
  useEffect(watchLocalStartupDrafts, [])
  const drafts = useSyncExternalStore(subscribeStartupDraftSnapshot, readStartupDraftSnapshot)
  return visible && drafts.size > 0 ? <ActiveStartupDraftRecovery drafts={drafts} /> : null
})

function ActiveStartupDraftRecovery({
  drafts
}: {
  drafts: ReadonlyMap<string, AvailableStartupDraft>
}) {
  const hostId = useAppStore((state) =>
    getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId)
  )
  const draft = useAppStore((state) =>
    hostId && state.activeWorktreeId
      ? drafts.get(composeWorktreeHostIdentity(hostId, state.activeWorktreeId))
      : undefined
  )
  return hostId && draft ? (
    <StartupDraftNotice key={draft.id} hostId={hostId} draft={draft} />
  ) : null
}

function StartupDraftNotice({
  hostId,
  draft
}: {
  hostId: ExecutionHostId
  draft: AvailableStartupDraft
}) {
  const t = useTranslate()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    const stop = new AbortController()
    void startupDraftRpc<string | null>(hostId, draft, 'read', stop.signal)
      .then((value) => {
        if (!stop.signal.aborted) {
          setText(value)
        }
      })
      .catch(() => undefined)
    return () => stop.abort()
  }, [hostId, draft])

  if (text === null) {
    return null
  }
  const dismiss = () => startupDraftRpc(hostId, draft, 'dismiss')
  const message =
    draft.outcome === 'not-delivered'
      ? t(
          'worktree.creation.startupDraftNotDelivered',
          'The startup prompt wasn’t delivered. Your draft is still available here.'
        )
      : t(
          'worktree.creation.startupDraftDeferred',
          'Your worktree is ready. The agent draft is still available here.'
        )
  return (
    <Card
      size="notice"
      className="absolute right-3 bottom-3 z-20 w-96 max-w-[calc(100%-1.5rem)] p-3"
    >
      <StartupDraftFields
        message={message}
        text={text}
        onCopy={() => {
          void window.api.ui
            .writeClipboardText(text)
            .then(dismiss)
            .catch(() => undefined)
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        className="mt-2"
        onClick={() => void dismiss().catch(() => undefined)}
      >
        {t('auto.components.worktree.creation.WorktreeCreationPanel.dabd226118', 'Dismiss')}
      </Button>
    </Card>
  )
}
