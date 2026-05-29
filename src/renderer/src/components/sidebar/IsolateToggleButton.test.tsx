import { describe, expect, it } from 'vitest'
import { formatBuildProgress, getIsolateToggleView } from './IsolateToggleButton'

describe('getIsolateToggleView', () => {
  it('renders off when Docker is available', () => {
    expect(
      getIsolateToggleView({
        isolation: 'host',
        engineStatus: { available: true, flavor: 'colima' },
        progress: null
      })
    ).toEqual({
      disabled: false,
      active: false,
      building: false,
      tooltip: 'Build image and enable Docker isolation',
      label: 'Build image and enable Docker isolation'
    })
  })

  it('renders building progress with the phase and percent', () => {
    const view = getIsolateToggleView({
      isolation: 'host',
      engineStatus: { available: true, flavor: 'colima' },
      progress: { worktreeId: 'wt-1', phase: 'build', percent: 42 }
    })

    expect(view.disabled).toBe(true)
    expect(view.building).toBe(true)
    expect(view.label).toBe('Building image... 42%')
  })

  it('renders on when the worktree is isolated', () => {
    const view = getIsolateToggleView({
      isolation: 'docker',
      engineStatus: { available: true, flavor: 'colima' },
      progress: null
    })

    expect(view.disabled).toBe(false)
    expect(view.active).toBe(true)
    expect(view.label).toBe('Docker isolation on')
  })

  it('renders disabled when Docker is not available', () => {
    expect(
      getIsolateToggleView({
        isolation: 'host',
        engineStatus: {
          available: false,
          flavor: 'docker-desktop-mac',
          reason: 'Docker Desktop or Colima socket was not found'
        },
        progress: null
      })
    ).toEqual({
      disabled: true,
      active: false,
      building: false,
      tooltip: 'Docker Desktop or Colima socket was not found',
      label: 'Docker not detected'
    })
  })

  it('renders disabled for SSH-mounted repos', () => {
    expect(
      getIsolateToggleView({
        isolation: 'host',
        engineStatus: { available: true, flavor: 'colima' },
        progress: null,
        isSshRepo: true
      })
    ).toEqual({
      disabled: true,
      active: false,
      building: false,
      tooltip: "Docker isolation isn't available for SSH-mounted repos.",
      label: "Docker isolation isn't available for SSH-mounted repos."
    })
  })
})

describe('formatBuildProgress', () => {
  it('formats pull progress', () => {
    expect(formatBuildProgress({ worktreeId: 'wt-1', phase: 'pull' })).toBe('Pulling image...')
  })
})
