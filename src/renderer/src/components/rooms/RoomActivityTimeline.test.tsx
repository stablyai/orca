/* @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoomSettledActivity } from '../../../../shared/rooms'
import { RoomActivityDetails, RoomSettledActivityTimeline } from './RoomActivityTimeline'

afterEach(cleanup)

describe('RoomSettledActivityTimeline', () => {
  it.each([
    ['TaskOutput', 'Read task output'],
    ['TaskStop', 'Stop task']
  ])('does not call a background command a subagent for %s', (name, label) => {
    render(
      <RoomActivityDetails
        messages={[
          {
            id: 'background-task',
            role: 'assistant',
            source: 'transcript',
            timestamp: 1,
            blocks: [{ type: 'tool-call', name, input: { task_id: 'background-sleep' } }]
          }
        ]}
      />
    )
    expect(screen.queryByText('Coordinated subagents')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Used tools' }))
    expect(screen.getByText(label!)).toBeTruthy()
  })
  it('keeps completed work expandable and opens captured file diffs', () => {
    const activity: RoomSettledActivity = {
      state: 'completed',
      startedAt: 1_000,
      completedAt: 129_000,
      messages: [
        {
          id: 'commentary',
          role: 'reasoning',
          source: 'transcript',
          timestamp: 2_000,
          blocks: [{ type: 'text', text: 'Inspecting the implementation.' }]
        },
        {
          id: 'edit',
          role: 'assistant',
          source: 'transcript',
          timestamp: 3_000,
          blocks: [
            {
              type: 'tool-call',
              name: 'apply_patch',
              input: {
                patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch'
              }
            }
          ]
        }
      ]
    }

    render(<RoomSettledActivityTimeline activity={activity} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 2m 8s' }))
    expect(screen.getByText('Inspecting the implementation.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edited files' }))
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/ }))

    expect(screen.getByRole('heading', { name: 'src/app.ts' })).toBeTruthy()
    expect(screen.getByText('-old')).toBeTruthy()
    expect(screen.getByText('+new')).toBeTruthy()
  })

  it('shows provider-independent tool labels', () => {
    const activity: RoomSettledActivity = {
      state: 'interrupted',
      startedAt: 1_000,
      completedAt: 2_000,
      messages: [
        {
          id: 'web',
          role: 'assistant',
          source: 'transcript',
          timestamp: 1_500,
          blocks: [{ type: 'tool-call', name: 'webrun', input: { search_query: [] } }]
        }
      ]
    }

    render(<RoomSettledActivityTimeline activity={activity} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 1s' }))
    fireEvent.click(screen.getByRole('button', { name: 'Searched the web' }))
    expect(screen.getByText('Search the web')).toBeTruthy()
  })
})
