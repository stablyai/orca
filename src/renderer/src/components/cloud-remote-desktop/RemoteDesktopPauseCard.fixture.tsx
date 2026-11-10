// The reconnect card inside a desktop tab lives in the VM's page glue (orca-desktop-page.js), not
// in React. These fixtures render that file's own stylesheet so the shots track the shipped CSS.
import pageSource from '../../../../../cloud/apps/sandbox-control/image/vm/orca-desktop-page.js?raw'
import { defineFixture } from '../../component-fixtures/component-fixture'

const PAGE_CSS = /style\.textContent = `([\s\S]*?)`;/.exec(pageSource)?.[1] ?? ''

/**
 * In the tab, prefers-color-scheme is Orca's theme (Orca sets Electron's theme source from its
 * setting). Fixtures switch a class instead, so pin the media query to the fixture's theme; the
 * entrance animation is pinned off so the shot never lands mid-fade.
 */
function cssFor(dark: boolean): string {
  return PAGE_CSS.replace(
    '@media (prefers-color-scheme: light)',
    dark ? '@media not all' : '@media all'
  ).replace('@media (prefers-reduced-motion: no-preference)', '@media not all')
}

function pauseFixture(message: string, tone: 'neutral' | 'error', width = 640) {
  return defineFixture({
    width,
    render: () => {
      const dark = document.documentElement.classList.contains('dark')
      return (
        // transform contains the card's position: fixed to this frame, as the tab's page does.
        <div className="relative h-[280px] overflow-hidden" style={{ transform: 'translateZ(0)' }}>
          <style>{cssFor(dark)}</style>
          {/* A stand-in Linux desktop behind the scrim. */}
          <div className="absolute inset-0 bg-[#3b5a7a]">
            <div className="absolute top-6 left-8 h-40 w-72 rounded-md border border-black/20 bg-[#f4f4f4] shadow-lg">
              <div className="h-6 rounded-t-md bg-[#d8d8d8]" />
            </div>
          </div>
          <div id="orca_pause" className="open">
            <div role={tone === 'neutral' ? 'status' : 'alert'}>
              <p>{message}</p>
              <button type="button">Reconnect</button>
            </div>
          </div>
        </div>
      )
    }
  })
}

export const pausedDisconnected = pauseFixture(
  'The remote desktop disconnected. Your files are safe.',
  'error'
)
export const pausedAsleep = pauseFixture(
  'This sandbox is asleep. Wake it in Orca, then reconnect.',
  'neutral'
)
export const pausedArchived = pauseFixture(
  'This workspace is archived. Unarchive it in Orca, then reconnect.',
  'neutral'
)
/** A narrow split pane: the card wraps inside the scrim's padding. */
export const pausedNarrow = pauseFixture(
  'The remote desktop disconnected. Your files are safe.',
  'error',
  300
)
