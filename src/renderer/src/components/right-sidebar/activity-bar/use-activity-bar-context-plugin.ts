import React, { useState } from 'react'

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
