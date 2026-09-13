import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { useViewport } from '@xyflow/react'
import { Globe, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import {
  measureEmbeddedBrowserPlacement,
  setEmbeddedBrowserPlacement
} from '../browser-pane/host-guest/embedded-browser-placement'
import type { CanvasNode } from './agent-canvas-document'

export const CanvasBrowserContext = createContext<{
  worktreeId: string
  executionHostId: string | undefined
  create: (url: string) => Promise<string>
} | null>(null)

export function AgentCanvasBrowser({
  node,
  readOnly,
  connecting,
  onEdit
}: {
  node: CanvasNode
  readOnly: boolean
  connecting: boolean
  onEdit: (
    id: string,
    patch: Partial<Pick<CanvasNode, 'title' | 'content' | 'browserTabId'>>
  ) => void
}) {
  const context = useContext(CanvasBrowserContext)
  const browser = useAppStore((state) => {
    if (!context || !node.browserTabId) {
      return undefined
    }
    const owner = state.unifiedTabsByWorktree[context.worktreeId]?.find(
      (tab) => tab.contentType === 'browser' && tab.entityId === node.browserTabId
    )
    if (!owner || owner.executionHostId !== context.executionHostId) {
      return undefined
    }
    return state.browserTabsByWorktree[context.worktreeId]?.find(
      (tab) => tab.id === node.browserTabId
    )
  })
  const [url, setUrl] = useState(node.content)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const busy = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)
  useViewport()
  const browserId = browser?.id
  const syncPlacement = useCallback(() => {
    const element = viewport.current
    const canvas = element?.closest<HTMLElement>('[data-agent-canvas]')
    if (browserId && element && canvas) {
      const owner = element.closest<HTMLElement>('.react-flow__node')!
      const ownerLayer = Number(getComputedStyle(owner).zIndex) || 0
      const occluders = Array.from(canvas.querySelectorAll<HTMLElement>('.react-flow__node'))
        .filter((candidate) => {
          if (candidate === owner) {
            return false
          }
          const layer = Number(getComputedStyle(candidate).zIndex) || 0
          return (
            layer > ownerLayer ||
            (layer === ownerLayer &&
              Boolean(owner.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
          )
        })
        .map((candidate) => candidate.getBoundingClientRect())
      setEmbeddedBrowserPlacement(
        browserId,
        measureEmbeddedBrowserPlacement(element, canvas, !connecting && !readOnly, occluders)
      )
    }
  }, [browserId, connecting, readOnly])
  // Other cards can move above this guest without changing this card's own position.
  useLayoutEffect(syncPlacement)
  useLayoutEffect(() => {
    if (!browserId || !viewport.current) {
      return
    }
    const element = viewport.current
    const canvas = element.closest<HTMLElement>('[data-agent-canvas]')
    const observer = new ResizeObserver(syncPlacement)
    observer.observe(element)
    if (canvas) {
      observer.observe(canvas)
    }
    window.addEventListener('resize', syncPlacement)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncPlacement)
      setEmbeddedBrowserPlacement(browserId, null)
    }
  }, [browserId, syncPlacement])
  useEffect(() => {
    if (browser && (browser.url !== node.content || browser.title !== node.title)) {
      onEdit(node.id, { content: browser.url, title: browser.title })
    }
    if (browser) {
      setUrl(browser.url)
    }
  }, [browser, node.id, node.content, node.title, onEdit])

  const open = async () => {
    if (!context || readOnly || busy.current) {
      return
    }
    const normalized = normalizeBrowserNavigationUrl(url)
    if (!normalized || !/^https?:\/\//i.test(normalized)) {
      setError(
        translate('agentCanvas.browserAddressRequired', 'Enter a website or localhost address.')
      )
      return
    }
    busy.current = true
    setOpening(true)
    setError(null)
    try {
      const browserTabId = await context.create(normalized)
      onEdit(node.id, { browserTabId, content: normalized })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      busy.current = false
      setOpening(false)
    }
  }

  return (
    <div
      ref={viewport}
      data-canvas-browser={browser?.id ?? ''}
      className="nodrag nopan nowheel relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      onKeyDown={(event) => event.stopPropagation()}
    >
      {!browser && (
        <form
          className="m-auto flex w-full max-w-md flex-col gap-3 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void open()
          }}
        >
          <Globe className="size-7 text-muted-foreground" />
          <p className="text-sm font-medium">
            {translate('agentCanvas.browserInside', 'Browse inside the canvas')}
          </p>
          <Input
            aria-label={translate('agentCanvas.browserUrl', 'Browser URL')}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              onEdit(node.id, { content: event.target.value })
            }}
            placeholder="localhost:3000"
            disabled={opening || readOnly}
            maxLength={8192}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={opening || readOnly || !url.trim()}>
            {opening && <Loader2 className="size-4 animate-spin" />}
            {translate('agentCanvas.loadBrowser', 'Open page')}
          </Button>
        </form>
      )}
    </div>
  )
}
