import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveCanonicalPaneAgentIdentity,
  type CanonicalPaneAgentIdentity
} from '../../../shared/pane-agent-identity-adapter'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'
import type { TuiAgent } from '../../../shared/tui-agent'

const AGENTS: readonly TuiAgent[] = ['claude', 'codex']
const SLOT_COUNT = 7
const SHAPE_COUNT = 3 ** SLOT_COUNT * 4 * 2
const TITLES: readonly string[] = ['', 'zsh', 'Task - claude', 'Task - codex']

type Breakdown = Record<
  'launch' | 'completed-hook' | 'sleeping-session' | 'process' | 'sibling' | 'title',
  number
>

function slotValues(mask: number): (TuiAgent | null)[] {
  let remaining = mask
  return Array.from({ length: SLOT_COUNT }, () => {
    const value = remaining % 3
    remaining = Math.floor(remaining / 3)
    return value === 0 ? null : AGENTS[value - 1]
  })
}

function canonicalResult(
  values: readonly (TuiAgent | null)[],
  title: string,
  withProof: boolean
): CanonicalPaneAgentIdentity {
  const [hook, siblingHook, completed, siblingCompleted, process, sleeping, launch] = values
  return resolveCanonicalPaneAgentIdentity({
    hookAgent: hook,
    hookIsLive: hook !== null,
    completedHookAgent: completed,
    launchAgent: launch,
    foregroundAgent: process,
    processProof:
      withProof && process
        ? {
            agent: process,
            processIncarnation: 'fixture-process',
            authorityId: 'fixture-authority',
            capturedAgeMs: 10,
            validForMs: 1_000
          }
        : undefined,
    sleepingSessionAgent: sleeping,
    siblingAgents: [siblingHook, siblingCompleted].filter(
      (agent): agent is TuiAgent => agent !== null
    ),
    allowSibling: true,
    title
  })
}

function realResult(values: readonly (TuiAgent | null)[], title: string, remote: boolean) {
  const [hook, siblingHook, completed, siblingCompleted, process, sleeping, launch] = values
  // The seven slots model steady-state observations; this runtime memory bit is intentionally
  // held true instead of adding an eighth dimension to the approved 17,496-shape table.
  return resolveTabAgentFromSignals({
    hasObservedAgentSignal: true,
    isRemote: remote,
    title,
    hookAgent: hook,
    siblingHookAgent: siblingHook,
    focusedCompletedHookAgent: completed,
    siblingCompletedHookAgent: siblingCompleted,
    processAgent: process,
    processShellForeground: false,
    sleepingSessionAgent: sleeping,
    launchAgent: launch ?? undefined
  })
}

function runDecisionTable(withProof: boolean) {
  let disagreements = 0
  let flipped = 0
  const breakdown: Breakdown = {
    launch: 0,
    'completed-hook': 0,
    'sleeping-session': 0,
    process: 0,
    sibling: 0,
    title: 0
  }
  for (let mask = 0; mask < 3 ** SLOT_COUNT; mask += 1) {
    const values = slotValues(mask)
    for (const title of TITLES) {
      for (const remote of [false, true]) {
        const real = realResult(values, title, remote)
        const canonical = canonicalResult(values, title, withProof)
        if (real !== canonical.agent) {
          disagreements += 1
          if (canonical.source !== null) {
            breakdown[canonical.source] += 1
          }
        }
        if (!withProof) {
          const proven = canonicalResult(values, title, true)
          if (
            canonical.agent !== proven.agent &&
            proven.source === 'process' &&
            (canonical.source === 'launch' ||
              canonical.source === 'completed-hook' ||
              canonical.source === 'sleeping-session')
          ) {
            flipped += 1
          }
        }
      }
    }
  }
  return { disagreements, flipped, breakdown }
}

describe('renderer ladder decision table', () => {
  it('replays the real shipping ladder and records all rung disagreements', () => {
    const proofFree = runDecisionTable(false)
    const freshProof = runDecisionTable(true)
    const result = {
      shapes: SHAPE_COUNT,
      proofOmitted: proofFree,
      freshProof,
      flippedByAddingProof: proofFree.flipped
    }
    writeFileSync(
      join(tmpdir(), 'orca-pane-agent-identity-decision-table-real.json'),
      `${JSON.stringify(result, null, 2)}\n`
    )
    // Re-derived against resolveTabAgentFromSignals (not a hand-written model). These differ from
    // the approved 2,520/648 totals and 396/144/72/36 breakdown; see the PR comment.
    expect(proofFree).toEqual({
      disagreements: 2_622,
      flipped: 1_872,
      breakdown: {
        launch: 1_884,
        'completed-hook': 478,
        'sleeping-session': 144,
        process: 0,
        sibling: 54,
        title: 6
      }
    })
    expect(freshProof).toEqual({
      disagreements: 658,
      flipped: 0,
      breakdown: {
        launch: 588,
        'completed-hook': 46,
        'sleeping-session': 0,
        process: 0,
        sibling: 6,
        title: 2
      }
    })
    expect(proofFree.flipped).toBe(1_872)
  })

  it('requires both freshness fields before process evidence can change the no-proof result', () => {
    const values = [null, null, null, null, 'codex', null, 'claude'] as const
    expect(canonicalResult(values, '', false)).toMatchObject({
      agent: 'claude',
      source: 'launch'
    })
    expect(
      resolveCanonicalPaneAgentIdentity({
        foregroundAgent: 'codex',
        processProof: {
          agent: 'codex',
          processIncarnation: 'fixture-process',
          authorityId: 'fixture-authority',
          capturedAgeMs: undefined as unknown as number,
          validForMs: 1_000
        },
        launchAgent: 'claude'
      })
    ).toMatchObject({ agent: 'claude', source: 'launch' })
    expect(
      resolveCanonicalPaneAgentIdentity({
        foregroundAgent: 'codex',
        processProof: {
          agent: 'codex',
          processIncarnation: 'fixture-process',
          authorityId: 'fixture-authority',
          capturedAgeMs: 10,
          validForMs: undefined as unknown as number
        },
        launchAgent: 'claude'
      })
    ).toMatchObject({ agent: 'claude', source: 'launch' })
  })
})
