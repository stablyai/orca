import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useTranslate } from '@/i18n/use-translate'
import { CloudWorkspaceOfflineView } from './CloudWorkspaceOfflineView'

function selectWorkspaceHasNoTabs(state: AppState, worktreeId: string): boolean {
  return (
    (state.unifiedTabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    (state.tabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    (state.browserTabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    !state.openFiles.some((file) => file.worktreeId === worktreeId)
  )
}

let cloudIds: Promise<Set<string>> | null = null
function knownCloudWorkspaceIds(): Promise<Set<string>> {
  const api = window.api?.orcaCloudWorkspace
  if (!api) {
    return Promise.resolve(new Set())
  }
  // Re-read on every mount of a new workspace id (cheap IPC); cached per tick only.
  cloudIds ??= api
    .listCloudWorkspaceIds()
    .then((ids) => new Set(ids))
    .catch(() => new Set<string>())
    .finally(() => setTimeout(() => (cloudIds = null), 2_000))
  return cloudIds
}

/** A sleeping Orca Cloud workspace has no tabs; instead of a blank pane, show its cached copy. */
export function CloudWorkspaceOfflineNotice({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const empty = useAppStore(
    (state) => worktreeId !== null && selectWorkspaceHasNoTabs(state, worktreeId)
  )
  const [isCloud, setIsCloud] = useState(false)
  const [snapshot, setSnapshot] = useState<CloudOfflineSnapshot | null>(null)
  const [queued, setQueued] = useState<CloudQueuedPrompt[]>([])
  const [waking, setWaking] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    setIsCloud(false)
    if (worktreeId) {
      void knownCloudWorkspaceIds().then((ids) => live && setIsCloud(ids.has(worktreeId)))
    }
    return () => {
      live = false
    }
  }, [worktreeId])

  const refresh = useCallback(async () => {
    const api = window.api?.orcaCloudOffline
    if (!api || !worktreeId) {
      return
    }
    const [next, prompts] = await Promise.all([
      api.getSnapshot({ workspaceId: worktreeId }),
      api.listQueuedPrompts({ workspaceId: worktreeId })
    ])
    setSnapshot(next)
    setQueued(prompts)
    setNow(Date.now())
  }, [worktreeId])

  useEffect(() => {
    if (!isCloud || !empty || !worktreeId) {
      return
    }
    void refresh()
    const offQueue = window.api.orcaCloudOffline?.onQueuedPromptsChanged(({ workspaceId }) => {
      if (workspaceId === worktreeId) {
        void refresh()
      }
    })
    const offWake = window.api.orcaCloudWorkspace?.onWakeProgress((event) => {
      if (event.workspaceId !== worktreeId) {
        return
      }
      setWaking(event.phase === 'waking' || event.phase === 'connecting')
      if (event.phase === 'ready' || event.phase === 'failed') {
        void refresh()
      }
    })
    // Relative times ("5 minutes ago") stay honest without a re-read.
    const clock = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      offQueue?.()
      offWake?.()
      clearInterval(clock)
    }
  }, [isCloud, empty, worktreeId, refresh])

  if (!worktreeId || !isCloud || !empty || !snapshot || !snapshot.asleep) {
    return null
  }
  const wake = (): void => {
    setWaking(true)
    void window.api.ephemeralVm
      .resumeWorkspace({ workspaceId: worktreeId })
      .catch(() =>
        toast.error(t('components.orcaCloud.offline.wakeFailed', 'Could not wake the workspace.'))
      )
      .finally(() => {
        setWaking(false)
        void refresh()
      })
  }
  return (
    <div className="absolute inset-0 flex justify-center overflow-hidden bg-background">
      <CloudWorkspaceOfflineView
        snapshot={snapshot}
        queued={queued}
        waking={waking}
        now={now}
        onWake={wake}
        onQueue={async (sessionId, text) => {
          const answer = await window.api.orcaCloudOffline.queuePrompt({
            workspaceId: worktreeId,
            sessionId,
            text
          })
          if (!answer.ok) {
            toast.error(answer.message)
            return false
          }
          setWaking(true)
          void refresh()
          return true
        }}
        onCancel={(id) =>
          void window.api.orcaCloudOffline.cancelQueuedPrompt({ id }).then(() => refresh())
        }
        onEdit={async (id, text) => {
          const saved = await window.api.orcaCloudOffline.editQueuedPrompt({ id, text })
          void refresh()
          return saved
        }}
      />
    </div>
  )
}
