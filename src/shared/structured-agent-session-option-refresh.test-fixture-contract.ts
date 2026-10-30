import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'

export type PiRefreshHarness = {
  snapshot: () => readonly SessionOptionDescriptor[]
  capture: () => Readonly<Record<string, string>> | undefined
  demand: () => void
  pick: (value: string) => Promise<boolean>
  replace: (fence: number, otherHost?: boolean) => Promise<void>
  close: () => Promise<void>
}

export type PiRefreshMount = (host: {
  record: { sessionId: string }
  options: () => Promise<AgentSessionOptionsResult>
  catalog: () => Promise<AgentSessionModelCatalogResult>
  acceptEffort: (value: string) => Promise<AgentSessionOptionResult>
}) => Promise<PiRefreshHarness>

export type PiRefreshFixtureModule = {
  piOptionRefreshContract: (
    mount: PiRefreshMount,
    flush: (work: () => void) => Promise<void>
  ) => void
}
