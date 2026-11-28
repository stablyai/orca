import { emulatorOpeningMessage } from './session/emulator-opening-message'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { EmulatorPaneToolbar } from './devices/emulator-pane-toolbar'
import { EmulatorDeviceFrame } from './frame/emulator-device-frame'
import { MobileEmulatorAgentSetupGuideLayer } from './agent-setup/MobileEmulatorAgentSetupGuideLayer'
import { useEmulatorPaneSession } from './session/use-emulator-pane-session'
import { scrcpyDeviceIdFromStreamUrl } from './streaming/emulator-scrcpy-stream-url'
import { useEmulatorInputCheck } from './input/use-emulator-input-check'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useEffect, useMemo } from 'react'
import { emulatorServerLabel } from '@/lib/simulator/runtime/emulator-runtime-target'
import { EMULATOR_STREAM_LOST_EVENT } from '@/lib/simulator/runtime/emulator-runtime-attach'

type EmulatorPaneProps = {
  tab?: Tab
  worktreeId: string
  /** When false, pane was pre-mounted for split safety and should not auto-attach until active. */
  isActive?: boolean
}

export default function EmulatorPane({ tab, worktreeId, isActive = true }: EmulatorPaneProps) {
  const t = useTranslate()
  useUiLanguageRevision()
  const {
    devices,
    selectedUdid,
    setSelectedUdid,
    loading,
    error,
    selectionRequired,
    attach,
    markStreamLost,
    shutdown,
    sendTap,
    sendButton,
    sendGesture,
    sendRotate,
    displayName,
    deviceId,
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
  const serverLabel = useMemo(() => emulatorServerLabel(worktreeId), [worktreeId])
  // A server workspace's stream forward closed (the server disconnected): offer Connect again.
  useEffect(() => {
    const onLost = (event: Event): void => {
      if (event instanceof CustomEvent && event.detail?.worktreeId === worktreeId) {
        markStreamLost()
      }
    }
    window.addEventListener(EMULATOR_STREAM_LOST_EVENT, onLost)
    return () => window.removeEventListener(EMULATOR_STREAM_LOST_EVENT, onLost)
  }, [markStreamLost, worktreeId])

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
        serverLabel={serverLabel}
        onSelectDevice={(udid) => {
          setSelectedUdid(udid)
          void attach(udid)
        }}
        onAttach={() => void attach(selectedUdid ?? undefined)}
        onShutdown={() => void shutdown(selectedUdid ?? undefined)}
        onHome={() => void sendButton('home')}
        onRotate={() => void sendRotate()}
      />

      {selectionRequired && (
        <p role="status" className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {emulatorOpeningMessage(selectionRequired, t, serverLabel)}
        </p>
      )}
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
              {t('auto.components.emulator.pane.EmulatorPane.59b08fa031', 'No emulator connected')}
            </p>
          ) : null}
          <EmulatorDeviceFrame
            worktreeId={worktreeId}
            deviceId={deviceId}
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
