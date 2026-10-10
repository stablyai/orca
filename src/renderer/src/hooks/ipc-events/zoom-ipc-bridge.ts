import { writeNativeChatFontSize } from '@/components/native-chat/native-chat-font-size-write'
import { applyUIZoom } from '@/lib/ui-zoom'
import { computeEditorFontSize, nextEditorFontZoomLevel } from '@/lib/editor-font-zoom'
import { zoomLevelToPercent } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { stepUIZoomLevel } from '../../../../shared/ui-zoom-level'
import { useAppStore } from '../../store'
import { resolveZoomTarget } from '../resolve-zoom-target'
import { requestPdfZoom } from '@/components/editor/pdf-zoom-request'

export function registerZoomIpcBridge(unsubs: (() => void)[]): void {
  // Zoom handling for menu accelerators and keyboard fallback paths.
  unsubs.push(
    window.api.ui.onTerminalZoom((direction) => {
      const store = useAppStore.getState()
      const { activeView, activeTabType, editorFontZoomLevel, setEditorFontZoomLevel, settings } =
        store
      const target = resolveZoomTarget({
        activeView,
        activeTabType,
        activeElement: document.activeElement
      })
      if (target === 'chat') {
        void writeNativeChatFontSize(
          direction === 'in' ? 'increase' : direction === 'out' ? 'decrease' : 'reset'
        )
        return
      }
      if (target === 'terminal') {
        return
      }
      if (target === 'editor') {
        // Why: a PDF owns its page zoom; editor font zoom would change nothing visible.
        if (requestPdfZoom(direction)) {
          return
        }
        const next = nextEditorFontZoomLevel(editorFontZoomLevel, direction)
        setEditorFontZoomLevel(next)
        void window.api.ui.set({ editorFontZoomLevel: next })

        // Why: mirror the editor's base font (terminalFontSize) + clamping so the overlay percent matches the rendered size.
        const baseFontSize = settings?.terminalFontSize ?? 13
        const actual = computeEditorFontSize(baseFontSize, next)
        const percent = Math.round((actual / baseFontSize) * 100)
        dispatchZoomLevelChanged('editor', percent)
        return
      }

      const current = window.api.ui.getZoomLevel()
      const next = stepUIZoomLevel(current, direction)

      applyUIZoom(next)
      void window.api.ui.set({ uiZoomLevel: next })

      dispatchZoomLevelChanged('ui', zoomLevelToPercent(next))
    })
  )

  // Why: re-parse main-process agent status here so the renderer applies the same normalization regardless of hook vs OSC source.
}
