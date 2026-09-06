// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

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
    expect(trigger.closest('.rounded-lg')?.classList.contains('transition-colors')).toBe(true)
    fireEvent.click(trigger)
    expect(root.dataset.state).toBe('open')
    expect(
      root
        .querySelector('[data-room-activity-row="first"] .px-3.py-2')
        ?.classList.contains('transition-colors')
    ).toBe(true)
    expect(
      [...root.querySelectorAll('[data-room-activity-row]')].map((row) =>
        row.getAttribute('data-room-activity-row')
      )
    ).toEqual(['second', 'third', 'first'])

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

  it('keeps one bottom front card while the other activities collapse together', () => {
    const activities = [activity('first', 10), activity('second', 20)]
    const { container } = render(
      <RoomActivityStack
        activities={activities}
        participants={activities.map(({ participantId }) => participant(participantId))}
      />
    )
    const root = container.querySelector('[data-room-activity-stack]')!
    expect(screen.getAllByText('@first')).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Show 2 activity updates'))
    const otherActivities = root.querySelector('[data-room-activity-others]')!
    expect(otherActivities.getAttribute('data-state')).toBe('open')
    const collapse = screen.getByText('Collapse activities').closest('button')!
    fireEvent.click(collapse)

    const frontRow = root.querySelector('[data-room-activity-row="first"]')!
    const collapseRow = root.querySelector('[data-room-activity-collapse]')!
    expect(screen.getAllByText('@first')).toHaveLength(1)
    expect(frontRow.hasAttribute('inert')).toBe(true)
    expect(otherActivities.getAttribute('data-state')).toBe('closed')
    expect(otherActivities.hasAttribute('inert')).toBe(true)
    expect(collapseRow.getAttribute('aria-hidden')).toBe('true')

    fireEvent.animationEnd(otherActivities)
    expect(frontRow.hasAttribute('inert')).toBe(false)
  })

  it('preserves the front activity details across stack collapse', () => {
    const first = activity('first', 10)
    const second = { ...activity('second', 20), detail: 'Inspecting details' }
    const { container } = render(
      <RoomActivityStack
        activities={[first, second]}
        lastSteeredParticipantId="second"
        participants={[participant('first'), participant('second')]}
      />
    )

    fireEvent.click(screen.getByLabelText('Show 2 activity updates'))
    const frontRow = container.querySelector('[data-room-activity-row="second"]')!
    const detailsTrigger = frontRow.querySelector('button')!
    fireEvent.click(detailsTrigger)
    expect(detailsTrigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByText('Collapse activities'))
    fireEvent.animationEnd(container.querySelector('[data-room-activity-others]')!)
    fireEvent.click(screen.getByLabelText('Show 2 activity updates'))
    expect(frontRow.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps an early final-looking message inside the live activity card', () => {
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

    expect(container.textContent).not.toContain('Worked for')
    expect(container.textContent).not.toContain('Visible answer')
    fireEvent.click(container.querySelector('button')!)
    expect(container.textContent).toContain('Visible answer')
    expect(container.querySelector('[class~="border-border/70"]')).not.toBeNull()
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

  it('brings the last steered agent to the front without exposing its response', () => {
    const first = activity('first', 10)
    const second: RoomAgentActivity = {
      ...activity('second', 20),
      messages: [
        {
          id: 'steer',
          role: 'user',
          blocks: [{ type: 'text', text: 'Change course' }],
          timestamp: 21,
          source: 'stream'
        },
        {
          id: 'response',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Course changed' }],
          timestamp: 22,
          source: 'stream'
        },
        {
          id: 'tool',
          role: 'assistant',
          blocks: [{ type: 'tool-call', name: 'Read', input: {} }],
          timestamp: 23,
          source: 'stream'
        }
      ]
    }

    const { container, rerender } = render(
      <RoomActivityStack
        activities={[first, second]}
        lastSteeredParticipantId="second"
        participants={[participant('first'), participant('second')]}
      />
    )

    const trigger = screen.getByLabelText('Show 2 activity updates')
    expect(trigger.textContent).toContain('@second')
    expect(trigger.textContent).not.toContain('Course changed')
    expect(container.textContent).not.toContain('Course changed')
    fireEvent.click(trigger)
    const frontRow = container.querySelector('[data-room-activity-row="second"]')!
    expect(frontRow.textContent).not.toContain('Course changed')
    fireEvent.click(frontRow.querySelector('button')!)
    expect(frontRow.textContent).toContain('Course changed')
    expect(
      [...container.querySelectorAll('[data-room-activity-row]')].map((row) =>
        row.getAttribute('data-room-activity-row')
      )
    ).toEqual(['first', 'second'])

    rerender(
      <RoomActivityStack
        activities={[first, second]}
        lastSteeredParticipantId="first"
        participants={[participant('first'), participant('second')]}
      />
    )
    expect(
      [...container.querySelectorAll('[data-room-activity-row]')].map((row) =>
        row.getAttribute('data-room-activity-row')
      )
    ).toEqual(['first', 'second'])

    fireEvent.click(screen.getByText('Collapse activities'))
    fireEvent.animationEnd(container.querySelector('[data-room-activity-others]')!)
    expect(screen.getByLabelText('Show 2 activity updates').textContent).toContain('@first')
    fireEvent.click(screen.getByLabelText('Show 2 activity updates'))
    expect(
      [...container.querySelectorAll('[data-room-activity-row]')].map((row) =>
        row.getAttribute('data-room-activity-row')
      )
    ).toEqual(['second', 'first'])
  })

  it.each(['commentary', 'final'] as const)(
    'keeps streamed %s after steer under the single-card disclosure',
    (assistantPhase) => {
      const current: RoomAgentActivity = {
        ...activity('codex', 10),
        messages: [
          {
            id: 'steer',
            role: 'user',
            blocks: [{ type: 'text', text: 'Continue' }],
            timestamp: 11,
            source: 'stream'
          }
        ]
      }
      const { container, rerender } = render(
        <RoomActivityStack activities={[current]} participants={[participant('codex')]} />
      )
      const streamed: RoomAgentActivity = {
        ...current,
        messages: [
          ...current.messages,
          {
            id: 'response',
            role: 'assistant',
            assistantPhase,
            blocks: [{ type: 'text', text: 'Sleep finished' }],
            timestamp: 12,
            source: 'stream'
          }
        ]
      }
      rerender(<RoomActivityStack activities={[streamed]} participants={[participant('codex')]} />)
      expect(container.textContent).not.toContain('Sleep finished')
      const trigger = container.querySelector('button')!
      fireEvent.click(trigger)
      expect(container.textContent).toContain('Sleep finished')
      expect(trigger.textContent).not.toContain('Sleep finished')
      fireEvent.click(trigger)
      expect(container.textContent).not.toContain('Sleep finished')
    }
  )
})
