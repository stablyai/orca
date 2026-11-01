import { toast } from 'sonner'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { handleRuntimeClientEventResponse } from './runtime-client-events'
import { callRuntimeRpc } from './runtime-rpc-client'
import { showGeneratedInputNotice } from '@/lib/launch-agent-paste-timeout-notice'

const projected = new Map<string, Set<string>>()

export function applyGeneratedInputNotices(
  target: RuntimeClientTarget,
  notices: GeneratedAgentInputNotice[]
): void {
  const environment = target.kind === 'local' ? 'local' : target.environmentId
  const ids = projected.get(environment) ?? new Set<string>()
  projected.set(environment, ids)
  const wanted = new Set(notices.map((notice) => notice.id))
  const toastId = (id: string): string => `generated-input:${environment}:${id}`
  for (const id of ids) {
    if (!wanted.has(id)) {
      ids.delete(id)
      toast.dismiss(toastId(id))
    }
  }
  for (const notice of notices) {
    if (ids.has(notice.id)) {
      continue
    }
    ids.add(notice.id)
    const show = (): void => {
      showGeneratedInputNotice({
        ...notice,
        id: toastId(notice.id),
        onDismiss: () => {
          if (!ids.has(notice.id)) {
            return
          }
          void callRuntimeRpc(target, 'terminal.dismissGeneratedInputNotice', {
            id: notice.id
          }).then(
            () => {
              ids.delete(notice.id)
              toast.dismiss(toastId(notice.id))
            },
            () => {
              // Failed dismissal is not permission to discard the canonical notice.
              if (ids.has(notice.id)) {
                show()
              }
            }
          )
        }
      })
    }
    show()
  }
}

export function subscribeLocalGeneratedInputNotices(): () => void {
  let stopped = false
  let localUnsubscribe: (() => void) | undefined
  void window.api.runtime
    .subscribe({ method: 'runtime.clientEvents.subscribe' }, (response) => {
      if (stopped) {
        return
      }
      handleRuntimeClientEventResponse(
        response,
        (event) => {
          if (event.type === 'generatedInputNoticesChanged') {
            applyGeneratedInputNotices({ kind: 'local' }, event.notices)
          }
        },
        console.warn
      )
    })
    .then((subscription) => {
      if (stopped) {
        subscription.unsubscribe()
      } else {
        localUnsubscribe = subscription.unsubscribe
      }
    })
    .catch(console.warn)
  return () => {
    stopped = true
    localUnsubscribe?.()
  }
}
