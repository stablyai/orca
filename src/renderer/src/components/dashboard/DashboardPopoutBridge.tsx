import { useDashboardPopoutBridge } from './useDashboardPopoutBridge'

/** Opt-in pop-out IPC and snapshot subscriptions. */
export default function DashboardPopoutBridge(): null {
  useDashboardPopoutBridge(true)
  return null
}
