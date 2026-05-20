import { describe, expect, it } from 'vitest'
import { shouldShowLaunchWatchdogTimeout } from './QuickLaunchButton'

describe('shouldShowLaunchWatchdogTimeout', () => {
  it('lets the paste timeout own ready-but-not-pasteable notes launches', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        launchSource: 'notes_send',
        prompt: 'Fix the race in Source Control.',
        pasteDraftAfterLaunch: true,
        hasPty: true
      })
    ).toBe(false)
  })

  it('lets the paste timeout own ready-but-not-pasteable conflict-resolution launches', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        launchSource: 'conflict_resolution',
        prompt: 'Resolve the current rebase conflicts.',
        pasteDraftAfterLaunch: true,
        hasPty: true
      })
    ).toBe(false)
  })

  it('still reports notes launches where no PTY appeared', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        launchSource: 'notes_send',
        prompt: 'Fix the race in Source Control.',
        pasteDraftAfterLaunch: true,
        hasPty: false
      })
    ).toBe(true)
  })

  it('keeps the launch watchdog for notes launches without paste fallback', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        launchSource: 'notes_send',
        prompt: 'Start with this prompt.',
        pasteDraftAfterLaunch: false,
        hasPty: true
      })
    ).toBe(true)
  })

  it('keeps the launch watchdog for empty notes prompts and non-notes launch sources', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        launchSource: 'notes_send',
        prompt: '   \n\t',
        pasteDraftAfterLaunch: true,
        hasPty: true
      })
    ).toBe(true)

    expect(
      shouldShowLaunchWatchdogTimeout({
        launchSource: 'tab_bar_quick_launch',
        prompt: 'Start with this prompt.',
        pasteDraftAfterLaunch: true,
        hasPty: true
      })
    ).toBe(true)
  })
})
