// What a running turn is doing now, as the `activity` event tells a cloud that lists `turn.activity`:
// the tool it is inside in words, and its plan's steps when the agent keeps one. turnId is the
// turn-started `at`. Mirrors ConnectorActivityEventSchema in the connector contract.
export const CONNECTOR_TURN_ACTIVITY_LIMITS = {
  maxActivityTextChars: 120,
  maxActivitySteps: 20
} as const

// A turn's answer to a cloud that lists `answers.long`: what one message holds where it posts.
export const CONNECTOR_LONG_ANSWER_BYTES = 32 * 1024

export type ConnectorTurnActivityStep = {
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ConnectorTurnActivity = {
  kind: 'activity'
  turnId: number
  text?: string
  steps?: ConnectorTurnActivityStep[]
}
