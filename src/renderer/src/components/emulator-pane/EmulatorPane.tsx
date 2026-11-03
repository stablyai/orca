import type { Tab } from '../../../../shared/tab-types'
import { EmulatorPaneToolbar } from './emulator-pane-toolbar'
import { EmulatorDeviceFrame } from './emulator-device-frame'
import { MobileEmulatorAgentSetupGuideLayer } from './MobileEmulatorAgentSetupGuideLayer'
import { useEmulatorPaneSession } from './use-emulator-pane-session'
import { scrcpyDeviceIdFromStreamUrl } from './emulator-scrcpy-stream-url'
import { useEmulatorInputCheck } from './use-emulator-input-check'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

type EmulatorPaneProps = {
  tab?: Tab
  worktreeId: string
  /** When false, pane was pre-mounted for split safety and should not auto-attach until active. */
  isActive?: boolean
}

export default function EmulatorPane({ tab, worktreeId, isActive = true }: EmulatorPaneProps) {
  useUiLanguageRevision()
  const {
    devices,
    selectedUdid,
    setSelectedUdid,
    loading,
    error,
    attach,
    markStreamLost,
    shutdown,
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    displayName,
    previewUrl,
    wsUrl,
    streamKey,
    isLive,
    visualOrientation
  } = useEmulatorPaneSession({
    worktreeId,
    tabId: tab?.id,
    autoAttachOnMount: isActive
  })
  const { inputError, checkOnInteraction } = useEmulatorInputCheck(
    worktreeId,
    isLive ? (previewUrl ?? null) : null,
    streamKey
  )
  const visibleError = error ?? inputError

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
        onRotate={() => void sendRotate()}
      />

      {visibleError ? (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {visibleError}
        </div>
      ) : null}

      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted px-3 py-6"
        onPointerDownCapture={checkOnInteraction}
        onWheelCapture={checkOnInteraction}
        onKeyDownCapture={checkOnInteraction}
        onPasteCapture={checkOnInteraction}
      >
        <MobileEmulatorAgentSetupGuideLayer isActive={isActive}>
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
            onStreamLost={scrcpyDeviceIdFromStreamUrl(previewUrl) ? markStreamLost : undefined}
          />
        </MobileEmulatorAgentSetupGuideLayer>
      </div>
    </div>
  )
}
