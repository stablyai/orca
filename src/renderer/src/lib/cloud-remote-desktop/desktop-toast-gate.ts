/**
 * The desktop toast's visibility. Closing a progress notice only hides it: the flow goes on and
 * the desktop still opens when ready, so later progress stays hidden. A failure still shows,
 * since it carries the one next step.
 */
export function createDesktopToastGate<State extends { kind: string }>(io: {
  render: (state: State) => void
  hide: () => void
}): { show: (state: State) => void; closeByUser: () => void; dismiss: () => void } {
  let closedByUser = false
  return {
    show: (state) => {
      if (closedByUser && state.kind !== 'failed') {
        return
      }
      io.render(state)
    },
    closeByUser: () => {
      closedByUser = true
      io.hide()
    },
    dismiss: io.hide
  }
}
