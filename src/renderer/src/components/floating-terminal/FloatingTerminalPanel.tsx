import { renderFloatingTerminalPanelSurface } from './FloatingTerminalPanelSurface'
import type { FloatingTerminalPanelProps } from './state/floating-terminal-panel-types'
import { useFloatingTerminalPanelController } from './use-floating-terminal-panel-controller'
import { useTranslate } from '../../i18n/use-translate'

export function FloatingTerminalPanel(props: FloatingTerminalPanelProps): React.JSX.Element {
  const t = useTranslate()
  const surface = useFloatingTerminalPanelController(props)
  return renderFloatingTerminalPanelSurface(surface, t)
}
