import { useLayoutEffect } from 'react'
import { isTerminalZeroDimensionsDiagnostic } from '../../../../../shared/terminal/viewport/terminal-zero-dimensions-diagnostic'
import { mapPaneTerminalErrors } from '../errors/terminal-error-accumulation'
import type { TerminalPaneStoreController } from '../controller/use-terminal-pane-store-bindings'

export function useVisibleTerminalMeasurement({
  isVisible,
  setShouldMeasureHiddenStartup,
  setTerminalError,
  setTerminalErrorsByPaneId,
  shouldMeasureHiddenStartup
}: Pick<
  TerminalPaneStoreController,
  | 'isVisible'
  | 'setShouldMeasureHiddenStartup'
  | 'setTerminalError'
  | 'setTerminalErrorsByPaneId'
  | 'shouldMeasureHiddenStartup'
>) {
  useLayoutEffect(() => {
    if (isVisible && shouldMeasureHiddenStartup) {
      setShouldMeasureHiddenStartup(false)
    }
    if (isVisible) {
      setTerminalError((previous) =>
        previous && isTerminalZeroDimensionsDiagnostic(previous) ? null : previous
      )
      setTerminalErrorsByPaneId((current) =>
        mapPaneTerminalErrors(current, (message) =>
          isTerminalZeroDimensionsDiagnostic(message) ? null : message
        )
      )
    }
  }, [
    isVisible,
    shouldMeasureHiddenStartup,
    setShouldMeasureHiddenStartup,
    setTerminalError,
    setTerminalErrorsByPaneId
  ])
}
