import { useCallback, useEffect, useRef, useState } from 'react'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import type {
  BrowserBackResult,
  BrowserGotoResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserTabShowResult
} from '../../../../shared/runtime-types'
import { resolveBrowserAddressBarSubmission } from '@/components/browser-pane/navigate/browser-address-bar-navigation'
import {
  getRemoteBrowserKeyboardShortcut,
  getRemoteBrowserKeypressKey
} from '@/components/browser-pane/stream-remote/remote-browser-keyboard'
import { getRemoteBrowserMouseButton } from '@/components/browser-pane/stream-remote/remote-browser-page-input-model'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  maestroBrowserHistoryMethods,
  maestroBrowserAddressValue,
  maestroBrowserControlError,
  maestroBrowserNavigationAction,
  MaestroWorkspaceBrowserControls,
  MaestroWorkspaceBrowserViewport,
  type MaestroBrowserNavigationMethod
} from './MaestroWorkspaceBrowserControls'
import {
  maestroBrowserPreviewPoint,
  type MaestroBrowserPreviewPoint
} from './maestro-browser-preview-pointer'
import type { MaestroWorkspacePreviewMode } from './maestro-workspace-visibility'

const MAX_BROWSER_PREVIEW_CACHE_ENTRIES = 24
const SELECTED_CAPTURE_INTERVAL_MS = 320
const VISIBLE_CAPTURE_INTERVAL_MS = 1_200
const IDENTITY_CAPTURE_INTERVAL_MS = 2_400
const browserPreviewCache = new Map<string, string>()
const ignoreBrowserInteraction = (): void => {}

type BrowserControlState = 'checking' | 'available' | 'unavailable'
function rememberBrowserPreview(key: string, preview: string): void {
  browserPreviewCache.delete(key)
  browserPreviewCache.set(key, preview)
  while (browserPreviewCache.size > MAX_BROWSER_PREVIEW_CACHE_ENTRIES) {
    browserPreviewCache.delete(browserPreviewCache.keys().next().value!)
  }
}

export function MaestroWorkspaceBrowserPreview({
  target,
  pageId,
  browserWorkspaceId,
  receiptRevision,
  selected = false,
  previewMode = 'full',
  onInteract = ignoreBrowserInteraction
}: {
  target: RuntimeClientTarget
  pageId: string
  browserWorkspaceId: string
  receiptRevision: number
  selected?: boolean
  previewMode?: MaestroWorkspacePreviewMode
  onInteract?: () => void
}): React.JSX.Element {
  const targetKey = target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
  const captureKey = `${targetKey}:${browserWorkspaceId}:${pageId}`
  const cachedPreview = browserPreviewCache.get(captureKey) ?? null
  const [preview, setPreview] = useState<string | null>(cachedPreview)
  const [state, setState] = useState<'loading' | 'ready' | 'reconnecting'>(
    cachedPreview ? 'ready' : 'loading'
  )
  const [controlState, setControlState] = useState<BrowserControlState>('checking')
  const [controlReason, setControlReason] = useState<string | null>(null)
  const [addressBarValue, setAddressBarValue] = useState('about:blank')
  const [navigationPending, setNavigationPending] = useState(false)
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null)
  const [captureRevision, setCaptureRevision] = useState(0)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const addressBarRef = useRef<HTMLInputElement | null>(null)
  const latestTarget = useRef(target)
  const addressEditing = useRef(false)
  const inputQueue = useRef<Promise<unknown> | null>(null)
  const pendingWheel = useRef<(MaestroBrowserPreviewPoint & { dx: number; dy: number }) | null>(
    null
  )
  const wheelFrame = useRef<number | null>(null)
  const resolvedCaptureKey = useRef<string | null>(null)
  const keybindings = useAppStore((store) => store.keybindings)
  latestTarget.current = target

  const captureInterval = selected
    ? SELECTED_CAPTURE_INTERVAL_MS
    : previewMode === 'identity'
      ? IDENTITY_CAPTURE_INTERVAL_MS
      : VISIBLE_CAPTURE_INTERVAL_MS

  useEffect(() => {
    let active = true
    let capturing = false
    const retained = browserPreviewCache.get(captureKey) ?? null
    if (retained) {
      setPreview(retained)
      setState('ready')
      resolvedCaptureKey.current = captureKey
    } else if (resolvedCaptureKey.current !== captureKey) {
      setPreview(null)
      setState('loading')
    }
    const capture = async (): Promise<void> => {
      if (capturing) {
        return
      }
      capturing = true
      try {
        const screenshot = await callRuntimeRpc<BrowserScreenshotResult>(
          latestTarget.current,
          'browser.screenshot',
          { page: pageId, format: 'png' },
          { suppressFeatureInteraction: true }
        )
        if (!active) {
          return
        }
        const nextPreview = `data:image/${screenshot.format};base64,${screenshot.data}`
        rememberBrowserPreview(captureKey, nextPreview)
        setPreview(nextPreview)
        setState('ready')
        resolvedCaptureKey.current = captureKey
      } catch (error) {
        if (active) {
          setState(browserPreviewCache.has(captureKey) ? 'ready' : 'reconnecting')
          setControlState('unavailable')
          setControlReason(maestroBrowserControlError(error))
        }
      } finally {
        capturing = false
      }
    }
    void capture()
    const interval = setInterval(() => void capture(), captureInterval)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [browserWorkspaceId, captureInterval, captureKey, captureRevision, pageId, receiptRevision])

  useEffect(() => {
    let active = true
    setControlState('checking')
    setControlReason(null)
    void callRuntimeRpc<BrowserTabShowResult>(
      latestTarget.current,
      'browser.tabShow',
      { page: pageId },
      { timeoutMs: 15_000, suppressFeatureInteraction: true }
    )
      .then(({ tab }) => {
        if (!active) {
          return
        }
        if (!addressEditing.current) {
          setAddressBarValue(maestroBrowserAddressValue(tab.url))
        }
        setControlState('available')
      })
      .catch((error: unknown) => {
        if (!active) {
          return
        }
        setControlState('unavailable')
        setControlReason(maestroBrowserControlError(error))
      })
    return () => {
      active = false
    }
  }, [browserWorkspaceId, pageId, receiptRevision, targetKey])

  useEffect(
    () => () => {
      if (wheelFrame.current !== null) {
        window.cancelAnimationFrame(wheelFrame.current)
      }
    },
    []
  )

  const enqueueInput = (operation: () => Promise<unknown>): void => {
    const next = (inputQueue.current ?? Promise.resolve()).catch(() => {}).then(operation)
    inputQueue.current = next.catch(() => {})
  }
  const callBrowser = useCallback(
    <Result,>(method: string, params: Record<string, unknown>): Promise<Result> =>
      callRuntimeRpc<Result>(
        latestTarget.current,
        method,
        { page: pageId, ...params },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      ),
    [pageId]
  )
  const pointFor = (
    event: Pick<MouseEvent, 'clientX' | 'clientY'>
  ): MaestroBrowserPreviewPoint | null => {
    const image = imageRef.current
    return image ? maestroBrowserPreviewPoint(image, event) : null
  }

  const handlePointer = (
    event: React.PointerEvent<HTMLImageElement>,
    phase: 'down' | 'up'
  ): void => {
    const point = pointFor(event.nativeEvent)
    const button = getRemoteBrowserMouseButton(event.button)
    if (!point || !button || button === 'right') {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onInteract()
    event.currentTarget.focus()
    enqueueInput(async () => {
      await callBrowser('browser.mouseMove', point)
      await callBrowser(phase === 'down' ? 'browser.mouseDown' : 'browser.mouseUp', { button })
    })
  }

  const handleWheel = (event: React.WheelEvent<HTMLImageElement>): void => {
    const point = pointFor(event.nativeEvent)
    if (!point) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onInteract()
    const current = pendingWheel.current
    pendingWheel.current = {
      ...point,
      dx: (current?.dx ?? 0) + Math.round(event.deltaX),
      dy: (current?.dy ?? 0) + Math.round(event.deltaY)
    }
    if (wheelFrame.current !== null) {
      return
    }
    wheelFrame.current = window.requestAnimationFrame(() => {
      wheelFrame.current = null
      const wheel = pendingWheel.current
      pendingWheel.current = null
      if (!wheel || (wheel.dx === 0 && wheel.dy === 0)) {
        return
      }
      enqueueInput(async () => {
        await callBrowser('browser.mouseMove', { x: wheel.x, y: wheel.y })
        await callBrowser('browser.mouseWheel', { dx: wheel.dx, dy: wheel.dy })
      })
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    const key = getRemoteBrowserKeyboardShortcut(event) ?? getRemoteBrowserKeypressKey(event)
    if (!key) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onInteract()
    enqueueInput(() => callBrowser('browser.keypress', { key }))
  }

  const runNavigation = useCallback(
    async (method: MaestroBrowserNavigationMethod, url?: string): Promise<void> => {
      if (controlState !== 'available' || navigationPending) {
        return
      }
      onInteract()
      setNavigationPending(true)
      setNavigationNotice(null)
      try {
        const result = await callBrowser<
          BrowserGotoResult | BrowserBackResult | BrowserReloadResult
        >(method, method === 'browser.goto' ? { url: url ?? 'about:blank' } : {})
        setAddressBarValue(maestroBrowserAddressValue(result.url))
        addressEditing.current = false
        setCaptureRevision((revision) => revision + 1)
      } catch (error) {
        const reason = maestroBrowserControlError(error)
        setControlState('unavailable')
        setControlReason(reason)
        setNavigationNotice(reason)
      } finally {
        setNavigationPending(false)
      }
    },
    [callBrowser, controlState, navigationPending, onInteract]
  )

  const submitAddressBar = useCallback((): void => {
    const submission = resolveBrowserAddressBarSubmission(addressBarValue, { allowFileUrls: false })
    if (submission.status === 'invalid') {
      setNavigationNotice(submission.loadError.description)
      return
    }
    void runNavigation('browser.goto', submission.url)
  }, [addressBarValue, runNavigation])

  useEffect(() => {
    if (!selected) {
      return
    }
    const platform = getShortcutPlatform()
    const onWindowKeyDown = (event: KeyboardEvent): void => {
      if (keybindingMatchesAction('browser.focusAddressBar', event, platform, keybindings)) {
        event.preventDefault()
        event.stopPropagation()
        onInteract()
        addressBarRef.current?.focus()
        addressBarRef.current?.select()
        return
      }
      const method = maestroBrowserHistoryMethods.find((candidate) =>
        keybindingMatchesAction(
          maestroBrowserNavigationAction(candidate),
          event,
          platform,
          keybindings
        )
      )
      if (!method) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void runNavigation(method)
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => window.removeEventListener('keydown', onWindowKeyDown, true)
  }, [keybindings, onInteract, runNavigation, selected])

  const controlsDisabled = controlState !== 'available' || navigationPending
  const controlStatus =
    controlState === 'checking'
      ? translate(
          'auto.components.maestro.MaestroWorkspaceBrowserPreview.controlsChecking',
          'Checking this exact Browser page…'
        )
      : controlReason

  const browserToolbar = (
    <MaestroWorkspaceBrowserControls
      pageId={pageId}
      addressBarRef={addressBarRef}
      addressBarValue={addressBarValue}
      controlsDisabled={controlsDisabled}
      controlStatus={controlStatus}
      navigationNotice={navigationNotice}
      unavailable={controlState === 'unavailable'}
      navigationPending={navigationPending}
      onAddressBarChange={(value) => {
        addressEditing.current = true
        setAddressBarValue(value)
      }}
      onAddressBarFocus={(input) => {
        addressEditing.current = true
        input.select()
      }}
      onAddressBarBlur={() => {
        addressEditing.current = false
      }}
      onSubmitAddressBar={submitAddressBar}
      onInteract={onInteract}
      onNavigate={(method, url) => void runNavigation(method, url)}
    />
  )

  return (
    <div
      className={`flex size-full min-h-0 flex-col ${state === 'ready' ? 'bg-background' : 'bg-editor-surface'}`}
      data-maestro-browser-preview=""
    >
      {browserToolbar}
      <MaestroWorkspaceBrowserViewport
        pageId={pageId}
        preview={preview}
        state={state}
        imageRef={imageRef}
        onPointerDown={(event) => handlePointer(event, 'down')}
        onPointerUp={(event) => handlePointer(event, 'up')}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}
