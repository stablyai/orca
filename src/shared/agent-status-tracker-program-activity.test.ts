import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusTracker } from './agent-title-status'

function tracker() {
  const events: string[] = []
  const instance = createAgentStatusTracker(
    (title) => events.push(`idle:${title}`),
    () => events.push('working'),
    () => events.push('exited')
  )
  return { instance, events }
}

describe('createAgentStatusTracker with OSC 7501 activity', () => {
  it('drives edges from the program while its titles carry no status glyph', () => {
    // Claude Code drops its ⠂/✳ prefix once the terminal answers the OSC 7501 probe.
    const { instance, events } = tracker()
    instance.handleProgramActivity('idle')
    instance.handleTitle('Claude Code')
    instance.handleProgramActivity('working')
    instance.handleTitle('Fix the parser')
    instance.handleProgramActivity('permission')
    instance.handleProgramActivity('working')
    instance.handleProgramActivity('idle')
    expect(events).toEqual(['working', 'idle:Fix the parser', 'working', 'idle:Fix the parser'])
  })

  it('never reads a glyph-less title as an exit while the program reports', () => {
    const { instance, events } = tracker()
    instance.handleProgramActivity('idle')
    instance.handleTitle('some topic title the detector cannot classify ⟂')
    expect(events).toEqual([])
  })

  it('hands classification back to titles once the program stops reporting', () => {
    const { instance, events } = tracker()
    instance.handleProgramActivity('idle')
    instance.handleProgramActivity(null)
    instance.handleTitle('')
    expect(events).toEqual(['exited'])
  })

  it('leaves agents that never report OSC 7501 on title glyphs', () => {
    const onIdle = vi.fn()
    const instance = createAgentStatusTracker(onIdle)
    instance.handleTitle('⠂ Claude Code')
    instance.handleTitle('✳ Claude Code')
    expect(onIdle).toHaveBeenCalledWith('✳ Claude Code', 'idle')
  })
})
