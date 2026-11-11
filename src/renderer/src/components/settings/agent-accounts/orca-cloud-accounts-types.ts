// Contracts between S0's container and its rows.
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsLoad } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

export type OrcaCloudAccountsActions = {
  start: (agent: OrcaCloudAccountAgent) => void
  cancel: (agent: OrcaCloudAccountAgent) => void
  reopen: (agent: OrcaCloudAccountAgent) => void
  usePaste: () => void
  /** Resolves with a code when the token wasn't stored; the value is never echoed back. */
  pasteToken: (token: string) => Promise<OrcaCloudAgentsErrorCode | null>
  remove: (agent: OrcaCloudAccountAgent) => Promise<OrcaCloudAgentsErrorCode | null>
  setSource: (
    agent: OrcaCloudAccountAgent,
    source: 'sign-in' | 'key'
  ) => Promise<OrcaCloudAgentsErrorCode | null>
  copyCode: (code: string) => void
  retryLoad: () => void
  signIn: () => void
}

export type OrcaCloudAccountsViewProps = {
  load: OrcaCloudAgentAccountsLoad
  rows: Record<OrcaCloudAccountAgent, OrcaCloudAccountRow> | null
  actions: OrcaCloudAccountsActions
  /** The clock for elapsed times; fixtures pin it. */
  now: number
  /** Fixtures: open a row's Remove confirmation or a row-level save error. */
  initialConfirmRemove?: OrcaCloudAccountAgent
  initialRowError?: { agent: OrcaCloudAccountAgent; error: OrcaCloudAgentsErrorCode }
  /** Inside Settings → Agent accounts the page's Orca Cloud part already titles it. */
  hideHeader?: boolean
}
