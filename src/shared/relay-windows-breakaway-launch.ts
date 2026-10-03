/** The relay's names for the shared Windows breakaway launch contract. */
import {
  formatWindowsBreakawayLaunchReport,
  parseWindowsBreakawayLaunchReport,
  RELAY_WINDOWS_BREAKAWAY_CONTRACT,
  type WindowsBreakawayLaunchReport
} from './windows-breakaway-launch'

export {
  WINDOWS_BREAKAWAY_EXIT_CODES as RELAY_WINDOWS_BREAKAWAY_EXIT_CODES,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG as RELAY_WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG as RELAY_WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG as RELAY_WINDOWS_BREAKAWAY_STDOUT_FLAG
} from './windows-breakaway-launch'

export const RELAY_WINDOWS_BREAKAWAY_ARGS_FLAG = RELAY_WINDOWS_BREAKAWAY_CONTRACT.argsFlag
export const RELAY_WINDOWS_LAUNCH_REPORT_MARKER = RELAY_WINDOWS_BREAKAWAY_CONTRACT.reportMarker

export type RelayWindowsLaunchReport = WindowsBreakawayLaunchReport

export function parseRelayWindowsLaunchReport(output: string): RelayWindowsLaunchReport | null {
  return parseWindowsBreakawayLaunchReport(RELAY_WINDOWS_BREAKAWAY_CONTRACT, output)
}

export function formatRelayWindowsLaunchReport(report: RelayWindowsLaunchReport): string {
  return formatWindowsBreakawayLaunchReport(RELAY_WINDOWS_BREAKAWAY_CONTRACT, report)
}
