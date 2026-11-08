import {
  closesAppOsc133Zone,
  createOsc133CommandFinishedScanner,
  type Osc133CommandFinishedScanner
} from '../../output/terminal-osc133-command-finished'
import type { PtyForegroundGroupReader } from './pty-startup-ingress-contract'

/** `unsure`: the asker ran inside a shell command and may be exiting; `group` holds the terminal now (null: unknown). */
export type PtyQueryAskerSample =
  | { presence: 'present' | 'gone' }
  | { presence: 'unsure'; group: number | null }

export type PtyQueryAskerVerdict = 'present' | 'gone'

type HeldAsker = { group: number | null; finished: boolean; markers: Osc133CommandFinishedScanner }

/** A short-lived querier exits before its bytes are read, so it cannot be sampled itself (#14631, #16633). Stream order
 *  proves it ran inside a command (OSC 133;C); the command's 133;D, or another group taking the terminal, proves it gone. */
export class PtyQueryAskerPresence {
  private commandRunning = false
  // OSC 133 markers seen back to back since the last other output, as closesAppOsc133Zone reads them.
  private adjacentMarkers = ''
  private held: HeldAsker | null = null

  /** Without a foreground group (ConPTY), only the command's finish marker proves the asker gone. */
  constructor(private readonly readForegroundGroup?: PtyForegroundGroupReader) {}

  /** Each OSC 133 payload the PTY emits, in stream order; `adjacent`: no other output since the previous one. */
  noteMarker(payload: string, adjacent: boolean): void {
    const markers = adjacent ? this.adjacentMarkers : ''
    const marker = payload.charAt(0)
    this.adjacentMarkers = (markers + marker).slice(-2)
    if (marker === 'C') {
      this.commandRunning = true
    } else if (marker === 'D' && !closesAppOsc133Zone(markers, payload)) {
      this.commandRunning = false
    }
  }

  /** `finishedAfter`: whether the command's finish marker was read past the query. */
  sample(finishedAfter: () => boolean): PtyQueryAskerSample {
    if (!this.commandRunning) {
      return { presence: 'present' }
    }
    return finishedAfter()
      ? { presence: 'gone' }
      : { presence: 'unsure', group: this.foregroundGroup() }
  }

  /** Watch for the asker leaving, from the output read past its query. */
  hold(after: string, group: number | null): void {
    const held: HeldAsker = {
      group,
      finished: false,
      markers: createOsc133CommandFinishedScanner(() => {
        held.finished = true
      })
    }
    this.held = held
    held.markers.scan(after)
  }

  /** Feeds a later read to the held asker's finish watch; returns where its finish marker ends, or -1. */
  watch(read: string): number {
    return this.held?.markers.scan(read) ?? -1
  }

  /** `gone` once proven; otherwise `present` when `final`, else null to keep waiting. */
  judge(final: boolean): PtyQueryAskerVerdict | null {
    const held = this.held
    const group = held && !held.finished && held.group !== null ? this.foregroundGroup() : null
    if (held && (held.finished || (group !== null && group !== held.group))) {
      return 'gone'
    }
    return final ? 'present' : null
  }

  release(): void {
    this.held = null
  }

  private foregroundGroup(): number | null {
    const group = this.readForegroundGroup?.()
    return typeof group === 'number' ? group : null
  }
}

/** Where the last command finish marker in `output` ends, or -1. */
export function lastCommandFinishEnd(output: string): number {
  return createOsc133CommandFinishedScanner(() => {}).scan(output)
}
