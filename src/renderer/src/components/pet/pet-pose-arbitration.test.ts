import { describe, expect, it } from 'vitest'
import { arbitratePetPose } from './pet-pose-arbitration'

describe('arbitratePetPose', () => {
  it('shows the locomotion row while pacing, even when the agent state is idle', () => {
    // Pacing with an idle/breathing row playing reads as gliding, not walking.
    expect(arbitratePetPose('idle', true)).toEqual({ animation: 'running', pacing: true })
    expect(arbitratePetPose('running', true)).toEqual({ animation: 'running', pacing: true })
  })

  it('halts the pacing for states that are poses, not travel', () => {
    expect(arbitratePetPose('waiting', true)).toEqual({ animation: 'waiting', pacing: false })
    expect(arbitratePetPose('jumping', true)).toEqual({ animation: 'jumping', pacing: false })
    expect(arbitratePetPose('review', true)).toEqual({ animation: 'review', pacing: false })
  })

  it('keeps the agent state row when the pet is not walking anyway', () => {
    expect(arbitratePetPose('idle', false)).toEqual({ animation: 'idle', pacing: false })
    expect(arbitratePetPose('waiting', false)).toEqual({ animation: 'waiting', pacing: false })
  })

  it('passes drag rows through untouched — the drag owns the pet', () => {
    expect(arbitratePetPose('running-right', true)).toEqual({
      animation: 'running-right',
      pacing: false
    })
    expect(arbitratePetPose('running-left', false)).toEqual({
      animation: 'running-left',
      pacing: false
    })
  })
})
