import type { TerminalStreamEndVerdict } from '../../../../../../shared/terminal/stream/terminal-stream-end-verdict'

export type TerminalMultiplexEvent =
  | { type: 'ready' }
  | {
      type: 'subscribed'
      terminal?: string
      launchResult?: unknown
      streamId: number
      streamGeneration?: string
      capabilities?: {
        ackOutputSourceRanges?: 1
        outputPause?: 1
        outputPauseDropNotice?: 1
        inputAck?: 1
        outputCadence?: 1
      }
      inputLedgerId?: string
    }
  | { type: 'end'; streamId: number; verdict?: TerminalStreamEndVerdict }
  | { type: 'error'; streamId: number; message?: string }
  | {
      type: 'fit-override-changed'
      streamId: number
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }
  | {
      type: 'driver-changed'
      streamId: number
      driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
    }
  | { type: string; streamId?: number; [key: string]: unknown }

export const CONTROL_STREAM_ID = 0

export function isTerminalDriverState(
  value: unknown
): value is { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string } {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return false
  }
  return (
    value.kind === 'idle' ||
    value.kind === 'desktop' ||
    (value.kind === 'mobile' && 'clientId' in value && typeof value.clientId === 'string')
  )
}
