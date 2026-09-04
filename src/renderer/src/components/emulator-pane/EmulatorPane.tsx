import { useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Tab } from '../../../../shared/tab-types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { EmulatorPaneToolbar } from './emulator-pane-toolbar'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import { MobileEmulatorAgentSetupGuideLayer } from './MobileEmulatorAgentSetupGuideLayer'
import { useEmulatorPaneSession } from './use-emulator-pane-session'
import { saveEmulatorScreenshot } from './save-emulator-screenshot'
import { useEmulatorPaneZoom } from './emulator-pane-zoom'

type EmulatorPaneProps = {
  tab?: Tab
  worktreeId: string
  /** When false, pane was pre-mounted for split safety and should not auto-attach until active. */
  isActive?: boolean
}

export default function EmulatorPane({ tab, worktreeId, isActive = true }: EmulatorPaneProps) {
  const screenshotCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [screenshotAvailable, setScreenshotAvailable] = useState(false)
  const [savingScreenshot, setSavingScreenshot] = useState(false)
  const {
    devices,
    selectedUdid,
    setSelectedUdid,
    loading,
    error,
    attach,
    shutdown,
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    sendPosture,
    displayCommandPending,
    displayName,
    previewUrl,
    wsUrl,
    streamKey,
    isLive,
    visualOrientation,
    selectedDevice,
    session
  } = useEmulatorPaneSession({
    worktreeId,
    tabId: tab?.id,
    autoAttachOnMount: isActive
  })
  const zoom = useEmulatorPaneZoom(selectedUdid)
  const saveScreenshot = async (): Promise<void> => {
    const canvas = screenshotCanvasRef.current
    if (!canvas || savingScreenshot) {
      return
    }
    setSavingScreenshot(true)
    try {
      const result = await saveEmulatorScreenshot(canvas, new Date())
      if (!result.canceled) {
        toast.success(
          translate(
            'auto.components.emulator.pane.EmulatorPane.savedScreenshot',
            'Saved emulator screenshot'
          )
        )
      }
    } catch (error) {
      toast.error(
        extractIpcErrorMessage(
          error,
          translate(
            'auto.components.emulator.pane.EmulatorPane.saveScreenshotFailed',
            'Could not save emulator screenshot'
          )
        )
      )
    } finally {
      setSavingScreenshot(false)
    }
  }

  return (
    <div
      data-emulator-pane
      className="flex h-full min-h-0 flex-col bg-background text-sm text-foreground"
    >
      <EmulatorPaneToolbar
        displayName={displayName}
        isLive={isLive}
        loading={loading}
        devices={devices}
        selectedUdid={selectedUdid}
        onSelectDevice={(udid) => {
          setSelectedUdid(udid)
          void attach(udid)
        }}
        onAttach={() => void attach(selectedUdid ?? undefined)}
        onShutdown={() => void shutdown(selectedUdid ?? undefined)}
        onHome={() => void sendButton('home')}
        onRotate={() => void sendRotate('left')}
        backend={session?.info?.backend ?? selectedDevice?.backend}
        androidControls={{
          displayCommandPending,
          screenshotAvailable,
          savingScreenshot,
          zoomPercentage: zoom.percentage,
          zoomAvailability: zoom.availability,
          onButton: (name, options) => void sendButton(name, options),
          onPosture: (posture) => void sendPosture(posture),
          onRotate: (direction) => void sendRotate(direction),
          onScreenshot: () => void saveScreenshot(),
          onZoomChange: (action) => zoom.zoom(action)
        }}
      />

      {error ? (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted px-3 py-6">
        <MobileEmulatorAgentSetupGuideLayer isActive={isActive} worktreeId={worktreeId}>
          {!isLive && !loading ? (
            <p className="mb-4 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.emulator.pane.EmulatorPane.59b08fa031',
                'No emulator connected'
              )}
            </p>
          ) : null}
          <EmulatorDeviceFrame
            previewUrl={previewUrl}
            wsUrl={wsUrl}
            streamKey={streamKey}
            deviceName={displayName}
            loading={loading}
            isLive={isLive}
            visualOrientation={visualOrientation}
            isActive={isActive}
            onTap={(x, y) => void sendTap(x, y)}
            onGesture={(points) => void sendGesture(points)}
            onScreenshotCanvasChange={(canvas) => {
              screenshotCanvasRef.current = canvas
              setScreenshotAvailable(canvas !== null)
            }}
            zoomState={zoom.state}
            onZoomMetrics={zoom.setMetrics}
          />
        </MobileEmulatorAgentSetupGuideLayer>
      </div>
    </div>
  )
}
