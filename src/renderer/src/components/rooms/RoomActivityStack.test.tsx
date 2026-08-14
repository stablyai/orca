// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomAgentActivity, RoomParticipant } from '../../../../shared/rooms'
import { isOutsideActivityStackSafeArea, RoomActivityStack } from './RoomActivityStack'

function activity(participantId: string, startedAt: number): RoomAgentActivity {
  return {
    participantId,
    identity: participantId,
    state: 'working',
    kind: 'thinking',
    messages: [],
    startedAt,
    updatedAt: startedAt,
    anchorSequence: null
  }
}

function participant(id: string): RoomParticipant {
  return {
    id,
    identity: id,
    actorKind: 'agent',
    agent: 'codex'
  } as RoomParticipant
}

describe('RoomActivityStack', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  it('opens the stack from its front activity and closes beyond the safe margin', () => {
    const activities = [activity('first', 10), activity('second', 20), activity('third', 30)]
    const { container } = render(
      <RoomActivityStack
        activities={activities}
        participants={activities.map(({ participantId }) => participant(participantId))}
      />
    )
    const root = container.querySelector('[data-room-activity-stack]') as HTMLDivElement
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
      width: 100,
      height: 100
    } as DOMRect)

    expect(screen.getByText('+2 more')).toBeTruthy()
    const trigger = screen.getByLabelText('Show 3 activity updates')
    expect(trigger.textContent).toContain('@first')
    fireEvent.click(trigger)
    expect(root.dataset.state).toBe('open')

    fireEvent.pointerDown(root, { clientX: 50, clientY: 50 })
    fireEvent.click(root, { clientX: 50, clientY: 50 })
    expect(root.dataset.state).toBe('open')

    fireEvent.pointerDown(document.body, { clientX: 110, clientY: 50 })
    fireEvent.click(document.body, { clientX: 110, clientY: 50 })
    expect(root.dataset.state).toBe('open')

    act(() => {
      fireEvent.pointerDown(document.body, { clientX: 120, clientY: 50 })
      fireEvent.click(document.body, { clientX: 120, clientY: 50 })
    })
    expect(root.dataset.state).toBe('closed')

    fireEvent.click(screen.getByLabelText('Show 3 activity updates'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(root.dataset.state).toBe('closed')
  })

  it('uses a clamped twelve-percent safety margin', () => {
    const rect = { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 }
    expect(isOutsideActivityStackSafeArea({ x: 111, y: 50 }, rect)).toBe(false)
    expect(isOutsideActivityStackSafeArea({ x: 113, y: 50 }, rect)).toBe(true)
  })

  it('renders an explicit final outside the live activity card', () => {
    const finalizing: RoomAgentActivity = {
      ...activity('codex', 10),
      messages: [
        {
          id: 'reasoning',
          role: 'reasoning',
          blocks: [{ type: 'text', text: 'Checking' }],
          timestamp: 11,
          source: 'stream'
        },
        {
          id: 'final',
          role: 'assistant',
          assistantPhase: 'final',
          blocks: [{ type: 'text', text: 'Visible answer' }],
          timestamp: 20,
          source: 'stream'
        }
      ],
      updatedAt: 20
    }

    const { container } = render(
      <RoomActivityStack activities={[finalizing]} participants={[participant('codex')]} />
    )

    expect(screen.getByText('Worked for 1s')).toBeTruthy()
    expect(container.textContent).toContain('Visible answer')
    expect(container.querySelector('[class~="border-border/70"]')).toBeNull()
  })

  it('does not render a silent control final as completed activity', () => {
    const silent: RoomAgentActivity = {
      ...activity('codex', 10),
      messages: [
        {
          id: 'silent',
          role: 'assistant',
          assistantPhase: 'final',
          blocks: [{ type: 'text', text: '<orca-room-silent />' }],
          timestamp: 20,
          source: 'stream'
        }
      ]
    }

    const { container } = render(
      <RoomActivityStack activities={[silent]} participants={[participant('codex')]} />
    )

    expect(container.textContent).not.toContain('Worked for')
  })
})
