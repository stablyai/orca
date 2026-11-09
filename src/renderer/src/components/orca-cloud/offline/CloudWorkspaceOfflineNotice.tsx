import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type {
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { useTranslate } from '@/i18n/use-translate'
import { CloudWorkspaceOfflineView } from './CloudWorkspaceOfflineView'

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

/** A sleeping Orca Cloud workspace: instead of dead panes or a blank pane, show its cached copy. */
export function CloudWorkspaceOfflineNotice({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  // Keyed: switching workspaces starts from empty state, so one workspace's copy or composer
  // never shows (or sends) under another.
  return worktreeId ? <CloudWorkspaceOfflineFor key={worktreeId} worktreeId={worktreeId} /> : null
}

function CloudWorkspaceOfflineFor({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const [isCloud, setIsCloud] = useState(false)
  const [snapshot, setSnapshot] = useState<CloudOfflineSnapshot | null>(null)
  const [queued, setQueued] = useState<CloudQueuedPrompt[]>([])
  const [waking, setWaking] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    void knownCloudWorkspaceIds().then((ids) => live && setIsCloud(ids.has(worktreeId)))
    return () => {
      live = false
    }
  }, [worktreeId])

  const refresh = useCallback(async () => {
    const api = window.api?.orcaCloudOffline
    if (!api) {
      return
    }
    const [next, prompts] = await Promise.all([
      api.getSnapshot({ workspaceId: worktreeId }),
      api.listQueuedPrompts({ workspaceId: worktreeId })
    ])
    // Only answers about this workspace; anything else is dropped.
    setSnapshot(next && next.workspaceId === worktreeId ? next : null)
    setQueued(prompts.filter((prompt) => prompt.workspaceId === worktreeId))
    setNow(Date.now())
  }, [worktreeId])

  useEffect(() => {
    if (!isCloud) {
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
    // A workspace can fall asleep (idle sleep, phone) while shown; re-read on a slow beat.
    const clock = setInterval(() => void refresh(), 15_000)
    return () => {
      offQueue?.()
      offWake?.()
      clearInterval(clock)
    }
  }, [isCloud, worktreeId, refresh])

  // Asleep, its panes are gone (restored ones are dead); the cached copy replaces them.
  if (!isCloud || !snapshot || !snapshot.asleep || snapshot.workspaceId !== worktreeId) {
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
    <div className="absolute inset-0 z-10 flex justify-center overflow-hidden bg-background">
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
