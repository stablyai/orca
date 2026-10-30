import type { AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentSessionExecutionOptions } from './agent-session-execution-options'
import type {
  AgentSessionQueuedMessage,
  AgentSessionSlashCommand,
  AgentSessionCommandsResult,
  AgentSessionSubscribeEvent
} from './agent-session-wire'

type StoredQueuedMessage = {
  messageId: string
  position: number
  body: AgentJournalMessageItem
  options?: AgentSessionExecutionOptions
}

export type MobileQueuedEditHostFixture = {
  sessionId: string
  start: () => Promise<string>
  insert: (input: Omit<StoredQueuedMessage, 'position'>) => Promise<StoredQueuedMessage>
  read: (messageId: string) => StoredQueuedMessage | null
  published: (messageId: string) => Promise<AgentSessionQueuedMessage>
  request: (method: string, params: unknown) => Promise<unknown>
  restart: () => Promise<void>
  dispose: () => Promise<void>
}

export type MobileQueuedEditHostFixtureModule = {
  now: number
  createMobileQueuedEditHostFixture: () => Promise<MobileQueuedEditHostFixture>
}

export type AcpCommandOptionsFixtureModule = {
  AcpStructuredOptions: new () => {
    adoptCommands: (commands: readonly { name: string; description: string }[]) => void
    readCommands: () => AgentSessionSlashCommand[] | undefined
  }
}

export type MobileCommandMenuHostFixtureModule = {
  createMobileCommandMenuHostFixture: (
    provider: 'claude' | 'omp',
    holdPreparation?: boolean,
    population?: number
  ) => Promise<{
    sessionId: string
    sessionIds: readonly string[]
    preparations: () => number
    pending: (sessionId: string) => boolean
    releasePreparation: () => void
    request: (
      sessionId: string,
      clientCapabilities: readonly string[]
    ) => Promise<AgentSessionCommandsResult>
    starts: () => number
    read: () => Promise<AgentSessionCommandsResult>
    subscribe: (emit: (event: AgentSessionSubscribeEvent) => void) => Promise<() => void>
    retire: (scoped: boolean) => Promise<void>
    dispose: () => Promise<void>
  }>
}
