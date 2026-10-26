import type { TabBarItem } from './tab-bar-item-model'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { getBrowserTabLabel } from './BrowserTab'

export function tabItemLabel(
  item: TabBarItem,
  generatedTitlesEnabled: boolean,
  savedName: string | null
): string {
  if (item.type === 'terminal') {
    return resolveTerminalTabTitle(item.data, generatedTitlesEnabled, item.data.title)
  }
  if (item.type === 'browser') {
    return getBrowserTabLabel(item.data)
  }
  if (item.type === 'agent-session') {
    return savedName ?? item.data.label
  }
  if (item.type === 'simulator') {
    return item.data.label || 'Mobile Emulator'
  }
  return getEditorDisplayLabel(item.data)
}
