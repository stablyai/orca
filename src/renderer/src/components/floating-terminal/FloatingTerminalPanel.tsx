import { renderFloatingTerminalPanelSurface } from './FloatingTerminalPanelSurface'
import type { FloatingTerminalPanelProps } from './state/floating-terminal-panel-types'
import { useFloatingTerminalPanelController } from './use-floating-terminal-panel-controller'
import { useTranslate } from '../../i18n/use-translate'
import { useAppStore } from '@/store'
import { resolveFloatingPanelOpacity } from '../../../../shared/settings/floating-panel-opacity'

export function FloatingTerminalPanel(props: FloatingTerminalPanelProps): React.JSX.Element {
  const t = useTranslate()
  const opacity = useAppStore((state) =>
    resolveFloatingPanelOpacity(state.settings?.floatingTerminalPanelOpacity)
  )
  const surface = useFloatingTerminalPanelController(props)
  return renderFloatingTerminalPanelSurface(surface, opacity, t)
}
