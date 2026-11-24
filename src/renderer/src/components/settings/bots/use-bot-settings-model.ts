import { useCallback, useEffect, useRef, useState } from 'react'
import { readAgentPickerLaunchSupport } from '@/components/agent/agent-launch-picker-host-reads'
import { botHostTarget } from '@/lib/bot-hosts'
import { readModelMenuCatalog } from '@/runtime/native-chat/model-catalogs/model-menu-catalog-read'
import { modelMenuRequestContext } from '@/runtime/native-chat/model-catalogs/model-menu-invalidation'
import type { Bot } from '../../../../../shared/bot-types'
import { botSettingsModelLabel } from './bot-settings-model-label'

export function useBotSettingsModel(
  { agent, hostId, launch }: Pick<Bot, 'agent' | 'hostId' | 'launch'>,
  worktreeId: string
) {
  const target = botHostTarget(hostId)
  const scope = JSON.stringify([hostId, worktreeId, agent])
  const inherited = !launch?.model
  const [answer, setAnswer] = useState<{
    scope: string
    context: string
    model?: ReturnType<typeof botSettingsModelLabel>
  }>()
  const request = useRef<{ scope: string; observedModel?: string }>(null)
  const observeModel = useCallback(
    (id: string) => {
      if (request.current?.scope === scope) {
        request.current.observedModel = id
      }
      setAnswer((current) =>
        current?.scope === scope && current.model?.id !== id ? undefined : current
      )
    },
    [scope]
  )
  useEffect(() => {
    if (!inherited) {
      return
    }
    const controller = new AbortController()
    const lookup: NonNullable<typeof request.current> = { scope }
    request.current = lookup
    const context = modelMenuRequestContext(target)
    const worktree = `id:${worktreeId}`
    void Promise.all([
      readModelMenuCatalog({ target, agent, worktree }, true, controller.signal).catch(
        () => undefined
      ),
      readAgentPickerLaunchSupport(target, worktree, agent)
    ])
      .then(([catalog, seed]) => {
        if (!controller.signal.aborted && context === modelMenuRequestContext(target)) {
          const model = botSettingsModelLabel(agent, catalog, seed?.model, lookup.observedModel)
          setAnswer({ scope, context, model })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (request.current === lookup) {
          request.current = null
        }
      })
    return () => {
      controller.abort()
      request.current = null
    }
  }, [agent, inherited, scope, target, worktreeId])
  const model =
    answer?.scope === scope && answer.context === modelMenuRequestContext(target)
      ? answer.model
      : undefined
  return inherited ? { model, observeModel } : undefined
}
