import { isTerminalFocusReportOnly } from '../../../../shared/terminal-untyped-input'
import { isXtermHoverMotionReport } from './terminal-pointer-input-sequences'

/** Bytes xterm emits without anyone driving the terminal: focus reports and button-less hover. */
export function isPassiveTerminalInputReport(data: string): boolean {
  return isTerminalFocusReportOnly(data) || isXtermHoverMotionReport(data)
}
