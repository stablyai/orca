import type { Tab } from '../../../../shared/types'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { isMacOs } from './emulator-pane-types'
import { EmulatorUnavailablePane } from './emulator-unavailable-pane'
import { EmulatorPaneToolbar } from './emulator-pane-toolbar'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import { useEmulatorPaneSession } from './use-emulator-pane-session'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

type EmulatorPaneProps = {
  tab?: Tab
  worktreeId: string
  /** When false, pane was pre-mounted for split safety and should not auto-attach until active. */
  isActive?: boolean
}

export default function EmulatorPane({ tab, worktreeId, isActive = true }: EmulatorPaneProps) {
  if (!isMacOs) {
    return <EmulatorUnavailablePane />
  }

  return <EmulatorPaneContent tab={tab} worktreeId={worktreeId} isActive={isActive} />
}

function EmulatorPaneContent({ tab, worktreeId, isActive = true }: EmulatorPaneProps) {
  const [latestFrameBytes, setLatestFrameBytes] = useState<ArrayBuffer | null>(null)
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
    displayName,
    previewUrl,
    wsUrl,
    streamKey,
    isLive
  } = useEmulatorPaneSession({
    worktreeId,
    tabId: tab?.id,
    autoAttachOnMount: isActive
  })

  const handleFrameBytes = useCallback((bytes: ArrayBuffer | null) => {
    setLatestFrameBytes(bytes)
  }, [])

  const handleSaveScreenshot = useCallback(async () => {
    if (!latestFrameBytes) {
      toast.error(
        translate(
          'auto.components.emulator.pane.EmulatorPane.5d5fd13391',
          'No emulator frame is available yet.'
        )
      )
      return
    }
    try {
      const result = await window.api.emulator.saveScreenshot({
        bytes: latestFrameBytes,
        deviceName: displayName
      })
      // Why: native save-dialog cancellation is an intentional user choice,
      // not a failed screenshot action.
      if (result.canceled) {
        return
      }
      toast.success(
        translate('auto.components.emulator.pane.EmulatorPane.360a8a4e68', 'Screenshot saved'),
        {
          action: result.destinationPath
            ? {
                label: translate('auto.components.emulator.pane.EmulatorPane.1a3df04ae1', 'Open'),
                onClick: () => {
                  void window.api.shell.openPath(result.destinationPath as string)
                }
              }
            : undefined
        }
      )
    } catch (error) {
      toast.error(
        extractIpcErrorMessage(
          error,
          translate(
            'auto.components.emulator.pane.EmulatorPane.bef0bb890f',
            'Failed to save screenshot.'
          )
        )
      )
    }
  }, [displayName, latestFrameBytes])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-sm text-foreground">
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
        onSaveScreenshot={() => void handleSaveScreenshot()}
        onShutdown={() => void shutdown(selectedUdid ?? undefined)}
        onHome={() => void sendButton('home')}
        onRotate={() => void sendRotate()}
        canSaveScreenshot={isLive && Boolean(latestFrameBytes)}
      />

      {error ? (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted px-3 py-6">
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
          onFrameBytes={handleFrameBytes}
          onTap={(x, y) => void sendTap(x, y)}
          onGesture={(points) => void sendGesture(points)}
        />
      </div>
    </div>
  )
}
