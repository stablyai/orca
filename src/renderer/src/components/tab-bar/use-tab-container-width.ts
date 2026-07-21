import { useAppStore } from '../../store'
import { normalizeTerminalTabWidth } from '../../../../shared/terminal-tab-width'
import { getTabContainerWidthClasses, getTabLabelWidthClasses } from './tab-width-rules'

type TabWidthClasses = {
  container: string
  label: string
}

// Why: single source so every tab surface (terminal, browser, editor) shrinks/grows
// to the same user-chosen preset; selecting a primitive keeps unrelated tabs from re-rendering.
export function useTabWidthClasses(): TabWidthClasses {
  const width = useAppStore((s) => normalizeTerminalTabWidth(s.settings?.terminalTabWidth))
  return {
    container: getTabContainerWidthClasses(width),
    label: getTabLabelWidthClasses(width)
  }
}
