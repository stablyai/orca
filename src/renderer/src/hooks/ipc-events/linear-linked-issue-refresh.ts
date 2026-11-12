import '@/store/slices/linear/linear-issue-read'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { scopedLinearCacheKey } from '@/store/slices/linear/linear-slice-scope'
import { consumeLinearIssueRead } from '@/store/slices/linear/linear-issue-read-lifecycle'
import { createCoalescedPollRunner } from '@/lib/source-control/refresh/coalesced-poll-runner'
import { resolveLinearLinkedIssueRefreshTargets } from './linear-linked-issue-refresh-targets'

type Update = Extract<RuntimeClientEvent, { type: 'linearLinkedIssueUpdated' }>

export function refreshDefaultLinkedLinearIssue(event: Update): void {
  void consumeLinearIssueRead(
    useAppStore.getState().refreshLinearIssue(event.identifier, event.workspaceId)
  ).catch((error) => {
    console.error('Failed to refresh updated Linear issue:', error)
  })
}

export function registerLinearLinkedIssueRefresh(unsubs: (() => void)[]) {
  const entries = new Map<string, { run: () => void; dispose: () => void }>()
  let stopped = false
  const owner = {
    handle(endpoint: RuntimeClientTarget, event: Update): void {
      if (stopped) {
        return
      }
      const targets = new Map<
        string,
        ReturnType<typeof resolveLinearLinkedIssueRefreshTargets>[number]
      >()
      for (const target of resolveLinearLinkedIssueRefreshTargets(
        useAppStore.getState(),
        endpoint,
        event
      )) {
        const key = JSON.stringify([
          target.scope.contextKey,
          scopedLinearCacheKey(
            target.scope,
            `${target.workspaceId ?? 'selected'}::${target.identifier}`
          )
        ])
        targets.set(key, target)
      }
      for (const [key, target] of targets) {
        let entry = entries.get(key)
        if (!entry) {
          const controller = new AbortController()
          const runner = createCoalescedPollRunner(
            async () => {
              if (!target.scope.isCurrentRuntime()) {
                return
              }
              await consumeLinearIssueRead(
                useAppStore.getState().fetchLinearIssue(target.identifier, target.workspaceId, {
                  scope: target.scope,
                  rejectCredentialError: true,
                  force: true
                }),
                () => !stopped && target.scope.isCurrentRuntime(),
                undefined,
                controller.signal
              )
            },
            { onIdle: () => entries.delete(key) }
          )
          entry = {
            run: () => runner.run(),
            dispose: () => {
              runner.dispose()
              controller.abort()
            }
          }
          entries.set(key, entry)
        }
        entry.run()
      }
    },
    dispose(): void {
      stopped = true
      for (const entry of entries.values()) {
        entry.dispose()
      }
      entries.clear()
    }
  }
  unsubs.push(owner.dispose)
  const stopLocal = window.api.linear?.onLinkedIssueUpdated?.((event) =>
    owner.handle({ kind: 'local' }, event)
  )
  if (stopLocal) {
    unsubs.push(stopLocal)
  }
  return owner
}
