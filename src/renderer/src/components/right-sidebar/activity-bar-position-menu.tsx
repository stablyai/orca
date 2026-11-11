import React, { useState } from 'react'
import { Power } from 'lucide-react'
import { toast } from 'sonner'
import type { ActivityBarPosition } from '../../../../shared/ui-chrome-types'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { useTranslate, type Translate } from '@/i18n/use-translate'
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
  onContextMenu: React.MouseEventHandler<HTMLElement>
  onPointerDown: React.PointerEventHandler<HTMLElement>
} {
  const [pluginKey, setPluginKey] = useState<string | null>(null)
  const updatePluginKey = (event: React.SyntheticEvent<HTMLElement>): void => {
    const target = event.target
    setPluginKey(
      target instanceof Element
        ? (target.closest('[data-activity-plugin-key]')?.getAttribute('data-activity-plugin-key') ??
            null)
        : null
    )
  }
  return {
    pluginKey,
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
  pluginKey
}: {
  currentPosition: ActivityBarPosition
  onChangePosition: (pos: ActivityBarPosition) => void
  pluginKey?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const [disabling, setDisabling] = useState(false)
  return (
    <ContextMenuContent>
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
