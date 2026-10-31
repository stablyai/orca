import { z } from 'zod'
import { normalizeAgentStatusPayload } from './agent-status-types'
import { normalizeProgramStatusFacet } from './program-status/facet'
import { parseTerminalGitHubPRUrl } from './terminal-github-pr-link-detector'

export const TERMINAL_TRANSIENTS_CAPABILITY = 'terminal-snapshots-v1'
export const TERMINAL_SIDE_EFFECT_STATE_CAPABILITY = 'terminal-side-effect-state.v1'

const ordinal = z.number().int().nonnegative().safe()
const time = z.number().finite()
const prompt = z.string().max(4096)
const statusPayload = z.unknown().transform((value, ctx) => {
  const payload = normalizeAgentStatusPayload(value)
  if (payload) {
    return payload
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid terminal status' })
  return z.NEVER
})
const facet = z.unknown().transform((value, ctx) => {
  const result = normalizeProgramStatusFacet(value)
  if (result) {
    return result
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid program facet' })
  return z.NEVER
})
const idleStatus = z.enum(['idle', 'permission'])
const title = z.object({
  rawTitle: z.string().max(1024),
  normalizedTitle: z.string().max(1024),
  staleWorkingTitleClear: z.boolean().optional()
})
const activity = z.enum(['working', 'idle', 'permission']).nullable()
const fact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command-started') }),
  z.object({ kind: z.literal('command-finished'), exitCode: z.number().int().safe().nullable() }),
  z.object({ kind: z.literal('bell') }),
  z.object({ kind: z.literal('title'), ...title.shape }),
  z.object({ kind: z.literal('agent-working') }),
  z.object({
    kind: z.literal('agent-idle'),
    title: z.string().max(1024),
    status: idleStatus.optional(),
    staleWorkingTitleClear: z.boolean().optional()
  }),
  z.object({ kind: z.literal('agent-exited') }),
  z.object({
    kind: z.literal('agent-status'),
    payload: statusPayload,
    fromProgramStatus: z.boolean().optional(),
    removesProgramStatusRow: z.boolean().optional()
  }),
  z.object({ kind: z.literal('program-facet'), facet: facet.nullable(), activity }),
  z.object({ kind: z.literal('command-code-working'), prompt }),
  z.object({ kind: z.literal('command-code-done'), prompt }),
  z.object({ kind: z.literal('2031-subscribe') }),
  z.object({ kind: z.literal('2031-unsubscribe') }),
  z.object({
    kind: z.literal('pr-link'),
    url: z
      .string()
      .max(2048)
      .refine((value) => parseTerminalGitHubPRUrl(value) !== null)
  })
])
export type TerminalTransientFact = z.infer<typeof fact>
export const terminalEffectKeys = [
  'command-started',
  'command-finished',
  'bell',
  'agent-working',
  'agent-idle',
  'agent-exited',
  'status-working',
  'status-blocked',
  'status-waiting',
  'status-done',
  'program-working',
  'program-blocked',
  'program-waiting',
  'program-done',
  'program-removal',
  'command-code-working',
  'command-code-done'
] as const
export type TerminalEffectKey = (typeof terminalEffectKeys)[number]
const effect = z.object({
  count: ordinal,
  order: ordinal,
  observedAt: time,
  commandOrdinal: ordinal,
  fact
})
export type TerminalSnapshotEffect = z.infer<typeof effect>
const current = z.object({
  command: z.enum(['unseen', 'uncertain', 'running', 'prompt']),
  commandRevision: ordinal,
  commandOrdinal: ordinal,
  mode2031: z.enum(['unknown', 'subscribed', 'unsubscribed']),
  modeRevision: ordinal,
  title: title.extend({ observedAt: time }).nullable(),
  activity,
  program: z
    .object({
      payload: statusPayload.nullable(),
      facet: facet.nullable(),
      activity,
      removesRow: z.boolean(),
      observedAt: time
    })
    .nullable(),
  inBandStatus: z.object({ payload: statusPayload, observedAt: time }).nullable(),
  commandCode: z.object({
    armed: z.boolean(),
    prompt,
    phase: z.enum(['unseen', 'working', 'done']),
    turnOrdinal: ordinal,
    observedAt: time
  })
})
export type TerminalTransientCurrent = z.infer<typeof current>
export const terminalSnapshotSchema = z.object({
  kind: z.literal('snapshot'),
  revision: ordinal,
  rawEndSeq: ordinal,
  current,
  effects: z.partialRecord(z.enum(terminalEffectKeys), effect),
  recentPrLinks: z
    .array(z.object({ url: z.string().max(2048), order: ordinal, observedAt: time }))
    .max(8)
})
export type TerminalTransientObservation = z.infer<typeof terminalSnapshotSchema>
export type TerminalTransientSink = {
  install: (
    current: TerminalTransientObservation,
    incarnationId: string,
    readCurrent: () => TerminalTransientObservation
  ) => void
  stage: (observation: TerminalTransientObservation) => void
  commit: () => void
  dispose?: () => void
}

export function isTerminalTransientObservation(
  value: unknown
): value is TerminalTransientObservation {
  return terminalSnapshotSchema.safeParse(value).success
}

export function terminalEffectKey(fact: TerminalTransientFact): TerminalEffectKey | null {
  switch (fact.kind) {
    case 'agent-status':
      return fact.removesProgramStatusRow
        ? 'program-removal'
        : `${fact.fromProgramStatus ? 'program' : 'status'}-${fact.payload.state}`
    case 'title':
    case 'program-facet':
    case '2031-subscribe':
    case '2031-unsubscribe':
    case 'pr-link':
      return null
    case 'agent-exited':
    case 'agent-idle':
    case 'agent-working':
    case 'bell':
    case 'command-code-done':
    case 'command-code-working':
    case 'command-finished':
    case 'command-started':
      return fact.kind
  }
}
