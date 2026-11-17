// Contracts between Cloud agent sign-ins' container and its rows.
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentAccountsLoad } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type {
  AgentDefaultSourceChoice,
  OrcaCloudAccountAgent,
  OrcaCloudAgentsErrorCode
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

export type OrcaCloudAccountsActions = {
  start: (agent: OrcaCloudAccountAgent) => void
  cancel: (agent: OrcaCloudAccountAgent) => void
  reopen: (agent: OrcaCloudAccountAgent) => void
  usePaste: () => void
  /** The code from Claude's sign-in page, for the waiting setup-token; the answer is a setup update. */
  submitSetupCode?: (code: string) => void
  /** Resolves with a code when the token wasn't stored; the value is never echoed back. */
  pasteToken: (token: string) => Promise<OrcaCloudAgentsErrorCode | null>
  remove: (agent: OrcaCloudAccountAgent) => Promise<OrcaCloudAgentsErrorCode | null>
  /** A default Source; null clears it ('in-workspace': sign in inside each workspace). */
  setSource: (
    agent: OrcaCloudAccountAgent,
    source: AgentDefaultSourceChoice
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
  /** Inside Settings › Orca Cloud › Cloud agent sign-ins the page already titles it. */
  hideHeader?: boolean
}
