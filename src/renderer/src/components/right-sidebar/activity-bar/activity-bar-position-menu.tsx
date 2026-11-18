import React, { useState } from 'react'
import { Power } from 'lucide-react'
import { toast } from 'sonner'
import type { ActivityBarPosition } from '../../../../../shared/ui-chrome/ui-chrome-types'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { ActivityBarItem } from './activity-bar-buttons'
import { reorderActivityOrders } from './activity-bar-arrangement'
import { scheduleActivityBarFocusHandoff } from './activity-bar-focus-handoff'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'

async function disableActivityBarPlugin(
  pluginKey: string,
  t: Translate,
  setDisabling: (disabling: boolean) => void
): Promise<void> {
  setDisabling(true)
  try {
    const plugins = await window.api.plugins.setEnabled({ pluginKey, enabled: false })
    usePluginPanelsStore.getState().setPlugins(plugins)
  } catch {
    toast.error(
      t('auto.components.right.sidebar.activityBar.disableFailed', 'Could not disable plugin.')
    )
  } finally {
    setDisabling(false)
  }
}

export function useActivityBarContextPlugin(): {
  pluginKey: string | null
  itemId: string | null
  onContextMenu: React.MouseEventHandler<HTMLElement>
  onPointerDown: React.PointerEventHandler<HTMLElement>
} {
  const [itemId, setItemId] = useState<string | null>(null)
  const [pluginKey, setPluginKey] = useState<string | null>(null)
  const updatePluginKey = (event: React.SyntheticEvent<HTMLElement>): void => {
    const target = event.target
    setItemId(
      target instanceof Element
        ? (target.closest('[data-activity-item-id]')?.getAttribute('data-activity-item-id') ?? null)
        : null
    )
    setPluginKey(
      target instanceof Element
        ? (target.closest('[data-activity-plugin-key]')?.getAttribute('data-activity-plugin-key') ??
            null)
        : null
    )
  }
  return {
    pluginKey,
    itemId,
    onContextMenu: updatePluginKey,
    onPointerDown: (event) => {
      if (event.pointerType !== 'mouse') {
        updatePluginKey(event)
      }
    }
  }
}

export function ActivityBarPositionMenu({
  currentPosition,
  onChangePosition,
  pluginKey,
  itemId,
  items,
  isBotPage = false,
  stripItemIds
}: {
  currentPosition: ActivityBarPosition
  onChangePosition: (pos: ActivityBarPosition) => void
  pluginKey?: string | null
  itemId?: string | null
  items: ActivityBarItem[]
  isBotPage?: boolean
  /** Top layout: moves run only among the tabs in the strip, not those under More. */
  stripItemIds?: ReadonlySet<string>
}): React.JSX.Element {
  const t = useTranslate()
  const hidden = useAppStore((s) => s.activityBarHidden)
  const setHidden = useAppStore((s) => s.setActivityBarHidden)
  const order = useAppStore((s) => s.activityBarOrder)
  const botOrder = useAppStore((s) => s.activityBarBotOrder)
  const setOrder = useAppStore((s) => s.setActivityBarOrder)
  const setBotOrder = useAppStore((s) => s.setActivityBarBotOrder)
  const shown = items.filter((item) => !item.pluginKey || !hidden.includes(item.id))
  const visible = stripItemIds ? shown.filter((item) => stripItemIds.has(item.id)) : shown
  const index = visible.findIndex((item) => item.id === itemId)
  const shownIndex = shown.findIndex((item) => item.id === itemId)
  const selected = items.find((item) => item.id === itemId)
  const activeTab = useAppStore((s) => s.rightSidebarEffectiveTab)
  const selectTab = useAppStore((s) => s.setRightSidebarTab)
  const move = (offset: number): void => {
    const ids = visible.map((item) => item.id)
    const target = index + offset
    if (index === -1 || target < 0 || target >= ids.length) {
      return
    }
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    const next = reorderActivityOrders({ order, botOrder }, isBotPage, ids)
    if (isBotPage) {
      setBotOrder(next.botOrder)
    } else {
      setOrder(next.order)
    }
  }
  const [disabling, setDisabling] = useState(false)
  return (
    <ContextMenuContent data-activity-bar-menu="">
      {selected && (
        <>
          <ContextMenuItem disabled={index <= 0} onSelect={() => move(-1)}>
            {currentPosition === 'top'
              ? t('activityBar.moveLeft', 'Move left')
              : t('activityBar.moveUp', 'Move up')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={index === -1 || index === visible.length - 1}
            onSelect={() => move(1)}
          >
            {currentPosition === 'top'
              ? t('activityBar.moveRight', 'Move right')
              : t('activityBar.moveDown', 'Move down')}
          </ContextMenuItem>
          {selected.pluginKey && !hidden.includes(selected.id) && (
            <ContextMenuItem
              onSelect={() => {
                const neighbour = shown[shownIndex + 1] ?? shown[shownIndex - 1]
                if (activeTab === selected.id) {
                  if (neighbour) {
                    selectTab(neighbour.id)
                  }
                }
                setHidden([...hidden, selected.id])
                scheduleActivityBarFocusHandoff(neighbour?.id)
              }}
            >
              {t('activityBar.hide', 'Hide')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
        </>
      )}
      {items
        .filter((item) => item.pluginKey && hidden.includes(item.id))
        .map((item) => (
          <ContextMenuItem
            key={item.id}
            onSelect={() => setHidden(hidden.filter((id) => id !== item.id))}
          >
            {t('activityBar.show', 'Show {{name}}', { name: item.title })}
          </ContextMenuItem>
        ))}
      <ContextMenuItem
        disabled={order.length === 0 && botOrder.length === 0 && hidden.length === 0}
        onSelect={() => {
          setOrder([])
          setBotOrder([])
          setHidden([])
        }}
      >
        {t('activityBar.reset', 'Reset tab order')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {pluginKey && typeof window.api?.plugins?.setEnabled === 'function' && (
        <>
          <ContextMenuItem
            disabled={disabling}
            onSelect={() => void disableActivityBarPlugin(pluginKey, t, setDisabling)}
          >
            <Power className="size-4" />
            {t('auto.components.right.sidebar.activityBar.disablePlugin', 'Disable Plugin')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuLabel>
        {t('auto.components.right.sidebar.index.864111caa2', 'Activity Bar Position')}
      </ContextMenuLabel>
      <ContextMenuRadioGroup
        value={currentPosition}
        onValueChange={(v) => onChangePosition(v as ActivityBarPosition)}
      >
        <ContextMenuRadioItem value="top">
          {t('auto.components.right.sidebar.index.7b415c39e9', 'Top')}
        </ContextMenuRadioItem>
        <ContextMenuRadioItem value="side">
          {t('auto.components.right.sidebar.index.70893f017b', 'Side')}
        </ContextMenuRadioItem>
      </ContextMenuRadioGroup>
    </ContextMenuContent>
  )
}
