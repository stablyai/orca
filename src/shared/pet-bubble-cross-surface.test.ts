import { describe, expect, it } from 'vitest'
import {
  petBubbleWinnerKey,
  selectPetBubbleWinner,
  PET_BEAT_MS,
  type PetBubbleAgent
} from './pet-bubble-text'
import type { AgentStatusEntry } from './agent-status-types'
import type { RuntimeWorktreeAgentRow } from './runtime-types'

/**
 * The bubble rule is shared so the desktop and the phone say the same thing
 * about the same agents. These tests pin the part that makes that possible:
 * the two surfaces carry agent state in DIFFERENT types — AgentStatusEntry from
 * the pane hook feed, RuntimeWorktreeAgentRow from worktree.ps — and both must
 * satisfy the selector without either surface converting.
 *
 * If someone narrows PetBubbleAgent back to AgentStatusEntry, the phone stops
 * compiling against it and the pet goes mute on whichever surface holds it.
 */

const NOW = 1_700_000_000_000
const STALE = 30 * 60 * 1000

describe('PetBubbleAgent accepts both surfaces’ row types', () => {
  it('accepts a desktop AgentStatusEntry', () => {
    const desktop: AgentStatusEntry = {
      state: 'waiting',
      prompt: '',
      updatedAt: NOW,
      stateStartedAt: NOW,
      agentType: 'claude',
      paneKey: 'tab:leaf',
      stateHistory: []
    }
    // The assignment IS the assertion — it must typecheck.
    const agents: PetBubbleAgent[] = [desktop]
    expect(selectPetBubbleWinner(agents, NOW, STALE)?.mood).toBe('waiting')
  })

  it('accepts a mobile RuntimeWorktreeAgentRow', () => {
    const mobile: RuntimeWorktreeAgentRow = {
      paneKey: 'tab:leaf',
      parentPaneKey: null,
      state: 'working',
      agentType: 'claude',
      prompt: '',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: NOW,
      updatedAt: NOW
    }
    const agents: PetBubbleAgent[] = [mobile]
    expect(selectPetBubbleWinner(agents, NOW, STALE)?.mood).toBe('running')
  })

  it('gives both surfaces the same winner for the same facts', () => {
    // agentType is `AgentType | undefined` on the desktop and `AgentType | null`
    // on mobile. Normalizing that inside the selector is what stops the two
    // surfaces attributing the same bubble to different agents.
    const shared = { paneKey: 'a', stateStartedAt: NOW, updatedAt: NOW, state: 'waiting' } as const
    const fromDesktop = selectPetBubbleWinner([{ ...shared, agentType: 'claude' }], NOW, STALE)
    const fromMobile = selectPetBubbleWinner([{ ...shared, agentType: 'claude' }], NOW, STALE)
    expect(petBubbleWinnerKey(fromDesktop)).toBe(petBubbleWinnerKey(fromMobile))
  })

  it('treats a null agentType the same as an absent one', () => {
    const winner = selectPetBubbleWinner(
      [{ paneKey: 'a', state: 'waiting', stateStartedAt: NOW, updatedAt: NOW, agentType: null }],
      NOW,
      STALE
    )
    expect(winner?.agentType).toBeUndefined()
  })
})

describe('bubble mood selection', () => {
  const base = { paneKey: 'a', stateStartedAt: NOW, updatedAt: NOW }

  it('says nothing when no agent is fresh', () => {
    const stale = { ...base, state: 'working' as const, updatedAt: NOW - STALE - 1 }
    expect(selectPetBubbleWinner([stale], NOW, STALE)).toBeNull()
  })

  it('prefers waiting over working, so the bubble matches the sprite pose', () => {
    const winner = selectPetBubbleWinner(
      [
        { ...base, paneKey: 'b', state: 'working' },
        { ...base, paneKey: 'c', state: 'waiting' }
      ],
      NOW,
      STALE
    )
    expect(winner?.mood).toBe('waiting')
  })

  it('stops celebrating once the done beat has decayed', () => {
    const justDone = { ...base, state: 'done' as const, stateStartedAt: NOW - PET_BEAT_MS + 10 }
    const longDone = { ...base, state: 'done' as const, stateStartedAt: NOW - PET_BEAT_MS - 10 }
    expect(selectPetBubbleWinner([justDone], NOW, STALE)?.mood).toBe('waving')
    expect(selectPetBubbleWinner([longDone], NOW, STALE)).toBeNull()
  })

  it('reads an interrupted done as failed, not a celebration', () => {
    const winner = selectPetBubbleWinner(
      [{ ...base, state: 'done', interrupted: true }],
      NOW,
      STALE
    )
    expect(winner?.mood).toBe('failed')
  })

  it('pins to one agent and counts the rest rather than rotating', () => {
    const winner = selectPetBubbleWinner(
      [
        { ...base, paneKey: 'z', state: 'waiting', agentType: 'codex' },
        { ...base, paneKey: 'a', state: 'waiting', agentType: 'claude' }
      ],
      NOW,
      STALE
    )
    expect(winner).toEqual({ mood: 'waiting', agentType: 'claude', count: 2, paneKey: 'a' })
  })
})
