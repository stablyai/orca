import { createPortal } from 'react-dom'
import { PluginDeclarativeView } from '../declarative/PluginDeclarativeView'
import type { PluginShotReplayPreview } from '@/store/plugin-shot-replay'

const ignoreEvent = (): void => {}

/**
 * `orca plugin shot --scenario`: the tree over everything at the viewport's corner, because
 * capturePage sees only what the window composites. Main draws it only while the window is hidden
 * or minimized. No image loader, so images keep their placeholder; events go nowhere.
 */
export default function PluginShotReplaySurface({
  preview
}: {
  preview: PluginShotReplayPreview
}): React.JSX.Element {
  return createPortal(
    <div
      key={preview.id}
      data-plugin-shot-replay=""
      aria-hidden
      inert
      className="pointer-events-none fixed top-0 left-0 z-[2147483647] flex max-h-screen flex-col overflow-hidden bg-sidebar"
      style={{ width: preview.width }}
    >
      <PluginDeclarativeView tree={preview.tree} onEvent={ignoreEvent} />
    </div>,
    document.body
  )
}
