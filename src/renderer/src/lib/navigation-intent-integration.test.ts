import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import { beginNavigationIntent, isCurrentNavigationIntent } from './navigation-intent'

describe('navigation intent integration', () => {
  it('is superseded by direct worktree activation attempts', () => {
    const pendingIntent = beginNavigationIntent()

    expect(activateAndRevealWorktree('missing-worktree')).toBe(false)
    expect(isCurrentNavigationIntent(pendingIntent)).toBe(false)
  })

  it('is superseded by direct folder workspace activation attempts', () => {
    const pendingIntent = beginNavigationIntent()

    expect(activateAndRevealFolderWorkspace('missing-folder-workspace')).toBe(false)
    expect(isCurrentNavigationIntent(pendingIntent)).toBe(false)
  })

  it('does not supersede a carried sidebar activation intent', () => {
    const pendingIntent = beginNavigationIntent()

    expect(activateAndRevealWorktree('missing-worktree', { navigationIntent: pendingIntent })).toBe(
      false
    )
    expect(isCurrentNavigationIntent(pendingIntent)).toBe(true)
  })

  it('preserves a carried intent while returning to the terminal view', () => {
    useAppStore.setState({ activeView: 'settings' })
    const pendingIntent = beginNavigationIntent()

    useAppStore.getState().setActiveView('terminal', { navigationIntent: pendingIntent })

    expect(isCurrentNavigationIntent(pendingIntent)).toBe(true)
    expect(useAppStore.getState().activeView).toBe('terminal')
  })

  it('rejects a stale carried view intent', () => {
    useAppStore.setState({ activeView: 'terminal' })
    const staleIntent = beginNavigationIntent()
    beginNavigationIntent()

    useAppStore.getState().setActiveView('settings', { navigationIntent: staleIntent })

    expect(useAppStore.getState().activeView).toBe('terminal')
  })

  it.each([
    ['setActiveView', () => useAppStore.getState().setActiveView('settings')],
    ['Tasks', () => useAppStore.getState().openTaskPage({}, { recordTasksInteraction: false })],
    ['Agents', () => useAppStore.getState().openActivityPage()],
    ['Automations', () => useAppStore.getState().openAutomationsPage()],
    ['Mobile', () => useAppStore.getState().openMobilePage()],
    ['Settings', () => useAppStore.getState().openSettingsPage()]
  ])('is superseded by explicit %s page navigation', (_name, navigate) => {
    const pendingIntent = beginNavigationIntent()

    navigate()

    expect(isCurrentNavigationIntent(pendingIntent)).toBe(false)
  })

  it('is superseded by raw worktree navigation', () => {
    const pendingIntent = beginNavigationIntent()

    useAppStore.getState().setActiveWorktree(null)

    expect(isCurrentNavigationIntent(pendingIntent)).toBe(false)
  })

  it('is superseded by page history navigation', () => {
    useAppStore.setState({
      activeView: 'automations',
      worktreeNavHistory: ['tasks', 'automations'],
      worktreeNavHistoryIndex: 1
    })
    const pendingIntent = beginNavigationIntent()

    useAppStore.getState().goBackWorktree()

    expect(isCurrentNavigationIntent(pendingIntent)).toBe(false)
    expect(useAppStore.getState().activeView).toBe('tasks')
  })
})
