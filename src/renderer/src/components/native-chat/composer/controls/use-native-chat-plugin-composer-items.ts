import { createContext, useEffect, useMemo, useRef, useState } from 'react'
import { shallow } from 'zustand/shallow'
import type { PluginHostListEntry } from '../../../../../../shared/plugins/plugin-list-entry'
import type { SessionOptionDescriptor } from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  ensurePluginPanelsLoaded,
  fromPlugin,
  installedPluginDisplayNames,
  isLivePlugin,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import {
  pluginComposerItemResultSchema,
  type PluginComposerItemContribution,
  type PluginComposerItemPopover
} from '../../../../../../shared/plugins/contributions/plugin-composer-item-contribution'

type ChatContext = {
  sessionId: string
  agent: string
  runtime: 'local' | 'remote'
  model: string | null
}
type Item = PluginComposerItemContribution & {
  key: string
  pluginKey: string
  pluginName: string
  revision: string | null
  devChangeCount: number | undefined
}
type Display = NonNullable<ReturnType<typeof pluginComposerItemResultSchema.parse>>
export type NativeChatPluginComposerItem = Omit<Item & Display, 'popover'> & {
  popover?: PluginComposerItemPopover
  runCommand: (commandId: string) => Promise<void>
}

/** The model the chat's model pill shows: a provider fallback when one runs, else the selection. */
export function nativeChatSessionModel(
  snapshot: readonly SessionOptionDescriptor[] | undefined
): string | undefined {
  const model = snapshot?.find((descriptor) => descriptor.category === 'model')
  return (
    model?.fallbackModel ?? (model?.kind.type === 'select' ? model.kind.currentValue : undefined)
  )
}

function invokeComposerItemCommand(
  item: Item,
  commandId: string,
  chat: ChatContext
): Promise<unknown> {
  return window.api.plugins.invokeCommand({
    pluginKey: item.pluginKey,
    commandId,
    args: { ...chat, itemId: item.id }
  })
}

const EMPTY_ITEMS: NativeChatPluginComposerItem[] = []
export const NativeChatPluginComposerItems = createContext(EMPTY_ITEMS)
let previousPlugins: readonly PluginHostListEntry[] | undefined
let previousItems: Item[] = []

function sameItem(left: Item, right: Item): boolean {
  const { popover: leftPopover, ...leftFields } = left
  const { popover: rightPopover, ...rightFields } = right
  return (
    shallow(leftFields, rightFields) && JSON.stringify(leftPopover) === JSON.stringify(rightPopover)
  )
}

function selectComposerItems({ plugins }: { plugins: readonly PluginHostListEntry[] }): Item[] {
  if (previousPlugins === plugins) {
    return previousItems
  }
  const names = installedPluginDisplayNames(plugins)
  const items = plugins.filter(isLivePlugin).flatMap((plugin) =>
    (plugin.composerItems ?? []).map((item) => ({
      ...fromPlugin(plugin, item, names),
      key: `${plugin.pluginKey}/${item.id}`,
      revision: plugin.source?.contentHash ?? plugin.consentFingerprint,
      devChangeCount: plugin.devChangeCount
    }))
  )
  previousPlugins = plugins
  // Starting or reaping a worker changes the list but must not trigger another resolution.
  if (
    items.length !== previousItems.length ||
    items.some((item, i) => !sameItem(item, previousItems[i]!))
  ) {
    previousItems = items
  }
  return previousItems
}

export function useNativeChatPluginComposerItems(
  { sessionId, agent, runtime, model }: Partial<ChatContext>,
  isWorking: boolean
): NativeChatPluginComposerItem[] {
  const items = usePluginPanelsStore(selectComposerItems)
  const chat = useMemo(
    () =>
      sessionId && agent && runtime && !isWebClientLocation()
        ? { sessionId, agent, runtime, model: model ?? null }
        : null,
    [sessionId, agent, runtime, model]
  )
  useEffect(() => {
    if (chat) {
      ensurePluginPanelsLoaded()
    }
  }, [chat])
  const [resolved, setResolved] = useState<{
    chat: ChatContext
    items: Item[]
    values: Map<string, Display | null>
  }>()
  const resolver = useRef<{
    chat: ChatContext
    items: Item[]
    resolve: (item: Item) => Promise<void>
  }>(null)
  useEffect(() => {
    if (!chat) {
      return
    }
    const context = chat
    let active = true
    const latest = new Map<string, symbol>()
    async function resolve(item: Item): Promise<void> {
      if (!item.resolve) {
        return
      }
      const request = Symbol()
      latest.set(item.key, request)
      try {
        const raw = await invokeComposerItemCommand(item, item.resolve, context)
        if (!active || latest.get(item.key) !== request) {
          return
        }
        const result = pluginComposerItemResultSchema.safeParse(raw)
        if (result.success) {
          setResolved((previous) => ({
            chat: context,
            items,
            values: new Map(
              previous?.chat === context && previous.items === items ? previous.values : []
            ).set(item.key, result.data)
          }))
        }
      } catch {
        // A refresh failure keeps the last successful display for this chat.
      }
    }
    resolver.current = { chat, items, resolve }
    if (!isWorking) {
      for (const item of items) {
        void resolve(item)
      }
    }
    return () => {
      active = false
      resolver.current = null
    }
  }, [chat, isWorking, items])

  return useMemo(() => {
    if (!chat || items.length === 0) {
      return EMPTY_ITEMS
    }
    // Why per context: another model's display would misstate what a click sends.
    const values = resolved?.chat === chat && resolved.items === items ? resolved.values : undefined
    return items.flatMap((item) => {
      const value = values?.get(item.key)
      const { popover: configuredPopover, ...defaults } = item
      const { popover: details, ...updates } = value ?? {}
      const display = { ...defaults, ...updates }
      if (value === null || display.visible === false || (!display.text && !display.icon)) {
        return []
      }
      const popover =
        configuredPopover && details !== null ? { ...configuredPopover, ...details } : undefined
      return [
        {
          ...display,
          popover,
          runCommand: async (commandId: string) => {
            await invokeComposerItemCommand(item, commandId, chat)
            const current = resolver.current
            if (current?.chat === chat && current.items === items) {
              await current.resolve(item)
            }
          }
        }
      ]
    })
  }, [chat, items, resolved])
}
