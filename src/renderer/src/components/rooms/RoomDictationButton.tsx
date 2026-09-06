import { useEffect, useState, type RefObject } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { dispatchDictationControl } from '@/components/dictation/dictation-control-events'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DeveloperPermissionStatus } from '../../../../shared/developer-permissions-types'

type RoomDictationUnavailableReason = 'configure' | 'permission' | null

export function getRoomDictationUnavailableReason(args: {
  enabled: boolean
  modelId: string | null | undefined
  microphonePermission: DeveloperPermissionStatus | null
}): RoomDictationUnavailableReason {
  if (!args.enabled || !args.modelId) {
    return 'configure'
  }
  return args.microphonePermission === 'denied' || args.microphonePermission === 'restricted'
    ? 'permission'
    : null
}

export function RoomDictationButton({
  textareaRef
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const [pressed, setPressed] = useState(false)
  const dictationState = useAppStore((state) => state.dictationState)
  const voice = useAppStore((state) => state.settings?.voice)
  const unavailable = getRoomDictationUnavailableReason({
    enabled: voice?.enabled === true,
    modelId: voice?.sttModel,
    microphonePermission: useMicrophonePermissionStatus()
  })
  const hold = voice?.dictationMode === 'hold'
  const active =
    pressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'
  const label =
    unavailable === 'configure'
      ? translate('rooms.composer.configureDictation', 'Configure voice transcription in Settings')
      : unavailable === 'permission'
        ? translate('rooms.composer.allowMicrophone', 'Allow microphone access in System Settings')
        : active
          ? translate('rooms.composer.stopDictation', 'Stop dictation')
          : translate('rooms.composer.startDictation', 'Start dictation')
  const start = (): void => {
    setPressed(true)
    textareaRef.current?.focus()
    dispatchDictationControl('start')
  }
  const stop = (): void => {
    setPressed(false)
    dispatchDictationControl('stop')
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant={active ? 'secondary' : 'ghost'}
            size="icon-xs"
            disabled={unavailable !== null}
            onClick={
              hold
                ? undefined
                : () => {
                    textareaRef.current?.focus()
                    dispatchDictationControl('toggle')
                  }
            }
            onPointerDown={(event) => {
              if (!hold || unavailable) {
                return
              }
              event.preventDefault()
              start()
            }}
            onPointerUp={() => {
              if (hold && !unavailable) {
                stop()
              }
            }}
            onPointerCancel={() => {
              if (hold && !unavailable) {
                stop()
              }
            }}
            onPointerLeave={(event) => {
              if (hold && event.buttons === 1 && !unavailable) {
                stop()
              }
            }}
            aria-label={label}
          >
            {active ? <Square className="size-3.5 fill-current" /> : <Mic className="size-4" />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function useMicrophonePermissionStatus(): DeveloperPermissionStatus | null {
  const [status, setStatus] = useState<DeveloperPermissionStatus | null>(null)

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void window.api.developerPermissions
        .getStatus()
        .then((states) => {
          if (!disposed) {
            setStatus(states.find((state) => state.id === 'microphone')?.status ?? null)
          }
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return status
}
