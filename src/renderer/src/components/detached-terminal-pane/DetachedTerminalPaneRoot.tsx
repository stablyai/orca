import { useEffect, useRef, useState } from 'react'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { applyDetachedTerminalTabSeed } from './detached-terminal-pane-seed'
import type { DetachedTerminalTabSeed } from '../../../../shared/types'

type DetachedTerminalPaneRootProps = {
  tabId: string
}

/** Flips the pop-out's PTY delivery interest on mount and back off on
 *  teardown, so byte streaming follows whichever window is actually showing
 *  the pane. See detachable-pane-window-manager.ts for the counterpart
 *  bookkeeping on the main-window side. */
function useDetachedRendererPtyDelivery(ptyId: string | null): void {
  useEffect(() => {
    if (!ptyId) {
      return
    }
    window.api.pty.setActiveRendererPty(ptyId, true)
    window.api.pty.setRendererPtyVisible(ptyId, true)
    return () => {
      window.api.pty.setActiveRendererPty(ptyId, false)
      window.api.pty.setRendererPtyVisible(ptyId, false)
    }
  }, [ptyId])
}

export function DetachedTerminalPaneRoot({
  tabId
}: DetachedTerminalPaneRootProps): React.JSX.Element | null {
  const [seed, setSeed] = useState<DetachedTerminalTabSeed | null>(null)
  const [seedFailed, setSeedFailed] = useState(false)
  const reintegratingRef = useRef(false)

  useEffect(() => {
    let disposed = false
    void window.api.pane
      .getDetachedTabSeed(tabId)
      .then((result) => {
        if (disposed) {
          return
        }
        if (!result) {
          setSeedFailed(true)
          return
        }
        applyDetachedTerminalTabSeed(result)
        setSeed(result)
      })
      .catch(() => {
        if (!disposed) {
          setSeedFailed(true)
        }
      })
    return () => {
      disposed = true
    }
  }, [tabId])
  useEffect(() => {
    if (!seed) {
      return
    }
    const title = seed.tab.customTitle ?? seed.tab.title
    if (title) {
      document.title = title
    }
  }, [seed])

  useDetachedRendererPtyDelivery(seed?.ptyId ?? null)

  useEffect(() => {
    const ptyId = seed?.ptyId
    if (!ptyId) {
      return
    }
    // Why: pre-hydrate scrollback before the live pty:data stream attaches,
    // so the first paint isn't a blank pane.
    void window.api.pty.getMainBufferSnapshot(ptyId).catch(() => null)
  }, [seed?.ptyId])

  const handleReintegrate = (): void => {
    if (reintegratingRef.current) {
      return
    }
    reintegratingRef.current = true
    void window.api.pane.reintegrate(tabId).finally(() => {
      window.close()
    })
  }

  if (seedFailed) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'detachedTerminalPane.seedMissing',
          'This terminal is no longer available in this window.'
        )}
      </div>
    )
  }

  if (!seed) {
    return null
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-border px-2 py-1">
        <Button variant="ghost" size="sm" onClick={handleReintegrate}>
          {translate('detachedTerminalPane.reintegrate', 'Return to main window')}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalPane
          tabId={seed.tab.id}
          worktreeId={seed.worktreeId}
          isActive
          isVisible
          onPtyExit={() => undefined}
          onCloseTab={handleReintegrate}
        />
      </div>
    </div>
  )
}
