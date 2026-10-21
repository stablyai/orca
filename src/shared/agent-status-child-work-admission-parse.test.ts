import { describe, expect, it, vi } from 'vitest'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import { normalizeChildWorkText } from './agent-status-child-work-value-guards'
import { createAgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'ssh:host-a',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

function observation(
  overrides: Partial<AgentChildWorkAnnounceRequest> = {}
): AgentChildWorkAnnounceRequest {
  return {
    parent,
    provider: 'claude',
    aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
    fence: { invocationId: 'invocation-1', generation: 1 },
    lifetime: 'current',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    observedAt: 10,
    stoppable: true,
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  }
}

function setup() {
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let sequence = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: vi.fn(() => `child-${++sequence}`)
  })
  return { store, admission }
}

type TextField = {
  cap: number
  carry: (raw: string) => Partial<AgentChildWorkAnnounceRequest>
  read: (child: AgentChildWorkRecord | null) => string | undefined
}

const TEXT_FIELDS: Record<string, TextField> = {
  name: { cap: 512, carry: (name) => ({ name }), read: (child) => child?.name },
  description: {
    cap: 8_000,
    carry: (description) => ({ description }),
    read: (child) => child?.description
  },
  agentType: { cap: 512, carry: (agentType) => ({ agentType }), read: (c) => c?.agentType },
  model: { cap: 512, carry: (model) => ({ model }), read: (child) => child?.model },
  'operation.toolName': {
    cap: 60,
    carry: (toolName) => ({ operation: { toolName, basis: 'open', observedAt: 10 } }),
    read: (child) => child?.operation?.toolName
  },
  'operation.input': {
    cap: 160,
    carry: (input) => ({ operation: { toolName: 'Bash', input, basis: 'open', observedAt: 10 } }),
    read: (child) => child?.operation?.input
  },
  lastMessage: { cap: 512, carry: (lastMessage) => ({ lastMessage }), read: (c) => c?.lastMessage }
}

function hostileText(cap: number): [string, string][] {
  return [
    ['a tab', 'col1\tcol2'],
    ['a CRLF', 'line one\r\nline two'],
    ['a line separator', 'one\u2028two'],
    ['a paragraph separator', 'one\u2029two'],
    ['a next-line control', 'one\u0085two'],
    ['a no-break space inside and around', '\u00a0keep\u00a0this\u00a0'],
    ['an escape sequence', 'plain \u001b[31mred'],
    ['a delete', 'rub\u007fout'],
    ['whitespace only', ' \t\r\n\u2028 '],
    // A space at character cap - 1, cap and cap + 1: just inside the cut, on it, and past it.
    ...[-1, 0, 1].map((offset): [string, string] => [
      `a space at character cap${offset < 0 ? '' : '+'}${offset}`,
      `${'x'.repeat(cap + offset - 1)} tail`
    ]),
    ['a surrogate pair split by the cut', `${'x'.repeat(cap - 1)}\u{1f600}tail`],
    ['a surrogate pair ending at the cut', `${'x'.repeat(cap - 2)}\u{1f600}tail`]
  ]
}

function breaksOneLine(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029
  })
}

describe('child-work admission parses provider text into what the codec stores', () => {
  const cases = Object.entries(TEXT_FIELDS).flatMap(([field, spec]) =>
    hostileText(spec.cap).map(([label, raw]) => [field, label, raw, spec] as const)
  )

  it.each(cases)('%s with %s is admitted at a fixed point', (_field, _label, raw, spec) => {
    const { store, admission } = setup()
    expect(admission.announce(observation(spec.carry(raw)))).toMatchObject({ accepted: true })
    const stored = spec.read(store.getChild('child-1'))
    expect(stored).toBe(normalizeChildWorkText(raw, spec.cap))
    if (stored === undefined) {
      return
    }
    expect(normalizeChildWorkText(stored, spec.cap)).toBe(stored)
    // Independent of the normalizer: one line, trimmed, within the cap, no half pair at the cut.
    expect(breaksOneLine(stored)).toBe(false)
    expect(stored).toBe(stored.trim())
    expect(stored.length).toBeLessThanOrEqual(spec.cap)
    const last = stored.charCodeAt(stored.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
  })

  it('keeps a surrogate pair whole when it ends exactly at the cap', () => {
    const { store, admission } = setup()
    admission.announce(observation({ lastMessage: `${'x'.repeat(510)}\u{1f600}tail` }))
    expect(store.getChild('child-1')?.lastMessage).toBe(`${'x'.repeat(510)}\u{1f600}`)
  })
})

function carrying(field: string, value: unknown): AgentChildWorkAnnounceRequest {
  const request = observation({ observedAt: 20 })
  // Producers are typed; this stands in for a producer bug the type cannot express.
  Reflect.set(request, field, value)
  return request
}

const GOOD = {
  name: 'researcher',
  description: 'Map the codebase',
  agentType: 'Explore',
  model: 'model-a',
  totalTokens: 5_000,
  providerTiming: { startedAt: 3 },
  parentChildWorkId: 'child-owner',
  residency: 'background',
  lastMessage: 'wrote 3 files'
} as const

// One row per descriptive fact: the record holds a good value and the request carries a bad one.
const ERASURE: [keyof typeof GOOD, string, unknown][] = [
  ['name', 'whitespace only', ' \t '],
  ['description', 'a bare line break', '\r\n'],
  ['agentType', 'a line separator only', '\u2028'],
  ['model', 'an empty string', ''],
  ['totalTokens', 'a negative count', -1],
  ['totalTokens', 'a fractional count', 1.5],
  ['totalTokens', 'NaN', Number.NaN],
  ['totalTokens', 'a count past the safe integers', 2 ** 60],
  ['providerTiming', 'a negative time', { startedAt: -1 }],
  ['providerTiming', 'an unknown key', { startedAt: 3, extra: 1 }],
  ['parentChildWorkId', 'an empty id', ''],
  ['parentChildWorkId', 'its own id', 'child-1'],
  ['parentChildWorkId', 'an id over 256 characters', 'x'.repeat(257)],
  ['residency', 'an unknown residency', 'detached'],
  ['lastMessage', 'line breakers only', '\u0085 \u2029']
]

describe('a malformed fact never erases what the record knows', () => {
  it.each(ERASURE)('keeps %s through a request carrying %s', (field, _case, bad) => {
    const { store, admission } = setup()
    expect(admission.announce(observation(GOOD))).toMatchObject({ accepted: true })
    expect(admission.announce(carrying(field, bad))).toMatchObject({
      accepted: true,
      childWorkId: 'child-1'
    })
    expect(store.getChild('child-1')).toMatchObject({ ...GOOD, observedAt: 20 })
  })

  it('admits a first sighting whose facts are all malformed, with none of them', () => {
    const { store, admission } = setup()
    const request = carrying('residency', 'detached')
    Reflect.set(request, 'totalTokens', -1)
    Reflect.set(request, 'parentChildWorkId', 'child-1')
    Reflect.set(request, 'name', '\u2028')
    expect(admission.announce(request)).toMatchObject({ accepted: true, created: true })
    const child = store.getChild('child-1')
    for (const field of ['residency', 'totalTokens', 'parentChildWorkId', 'name']) {
      expect(child).not.toHaveProperty(field)
    }
  })

  it('reads a malformed operation as the child doing nothing it can name', () => {
    const { store, admission } = setup()
    admission.announce(
      observation({ operation: { toolName: 'Bash', basis: 'open', observedAt: 10 } })
    )
    expect(
      admission.announce(
        carrying('operation', { toolName: 'Read', basis: 'guessed', observedAt: 20 })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).not.toHaveProperty('operation')
  })

  it('lands a settle whose token count is malformed, keeping the counted tokens', () => {
    const { store, admission } = setup()
    admission.announce(observation({ totalTokens: 5_000 }))
    expect(
      admission.announce(
        observation({
          state: 'done',
          membership: 'settled',
          outcome: 'succeeded',
          observedAt: 20,
          totalTokens: -1
        })
      )
    ).toMatchObject({ accepted: true })
    expect(store.getChild('child-1')).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      totalTokens: 5_000
    })
  })
})
