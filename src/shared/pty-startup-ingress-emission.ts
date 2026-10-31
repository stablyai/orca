import type { PtyOwnerColorQueryReplies } from './pty-owner-color-query-replies'
import type { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'
import type { PtyIngressEmission, PtyIngressSourceSpan } from './pty-startup-ingress-contract'

export abstract class PtyStartupIngressEmission {
  protected abstract readonly scope: { kitty: boolean; appearance: boolean }
  protected abstract readonly kittyModes: TerminalKittyKeyboardModeTracker
  protected abstract readonly colorQueries: PtyOwnerColorQueryReplies
  protected abstract readonly onEmission: (emission: PtyIngressEmission) => void

  /** `seen`: the owner already recorded these bytes' colour SETs while answering them in order. */
  protected emit(span: PtyIngressSourceSpan, transformed: boolean, data = span.data, seen = false) {
    if (this.scope.kitty) {
      this.kittyModes.scan(data)
    }
    if (!seen) {
      this.colorQueries.observe(data)
    }
    this.onEmission({ data, rawStartSeq: span.rawStartSeq, rawEndSeq: span.rawEndSeq, transformed })
  }
}
