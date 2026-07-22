import { describe, expect, it } from 'vitest'
import { resolveTerminalTabTitle, resolveUnifiedTabLabel } from './tab-title-resolution'

describe('tab title resolution', () => {
  it('uses live terminal titles when generated titles are disabled', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'Claude working' },
        false
      )
    ).toBe('Claude working')
  })

  it('places generated titles between manual and live titles when enabled', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'Claude working' },
        true
      )
    ).toBe('Refactor auth')
    expect(
      resolveTerminalTabTitle(
        { customTitle: 'Payments', generatedTitle: 'Refactor auth', title: 'Claude working' },
        true
      )
    ).toBe('Payments')
  })

  it('uses meaningful native OpenCode session titles before generated titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'Refactor auth',
          title: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('OC | Native Stable Session')
  })

  it('keeps generated titles ahead of generic OpenCode titles', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'OpenCode' },
        true
      )
    ).toBe('Refactor auth')
  })

  it('places quick command labels between manual and generated titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          generatedTitle: 'Refactor auth',
          title: 'pnpm test'
        },
        true
      )
    ).toBe('Run tests')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: 'Manual label',
          quickCommandLabel: 'Run tests',
          generatedTitle: 'Refactor auth',
          title: 'pnpm test'
        },
        true
      )
    ).toBe('Manual label')
  })

  it('fills in a renamed session name for tabs without their own title', () => {
    expect(
      resolveTerminalTabTitle({ customTitle: null, title: 'zsh' }, false, '', {
        displayName: 'auth refactor',
        branchName: 'feature/auth'
      })
    ).toBe('auth refactor')
  })

  it('ignores a session name that is still just the branch default', () => {
    expect(
      resolveTerminalTabTitle({ customTitle: null, title: 'zsh' }, false, '', {
        displayName: 'feature/auth',
        branchName: 'feature/auth'
      })
    ).toBe('zsh')
  })

  it('keeps per-tab, generated, and meaningful live titles ahead of the session name', () => {
    const sessionName = { displayName: 'auth refactor', branchName: 'main' }
    expect(
      resolveTerminalTabTitle({ customTitle: 'Manual', title: 'zsh' }, false, '', sessionName)
    ).toBe('Manual')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'zsh' },
        true,
        '',
        sessionName
      )
    ).toBe('Refactor auth')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, title: 'OC | Native Stable Session' },
        true,
        '',
        sessionName
      )
    ).toBe('OC | Native Stable Session')
  })

  it('uses the same priority for unified tab labels', () => {
    expect(
      resolveUnifiedTabLabel(
        { customLabel: null, generatedLabel: 'Fix flaky tests', label: 'Codex working' },
        true
      )
    ).toBe('Fix flaky tests')
  })

  it('uses quick command labels before generated unified labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'Codex working'
        },
        true
      )
    ).toBe('Run build')
  })

  it('uses meaningful native OpenCode labels before generated unified labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('OC | Native Stable Session')
  })

  it('keeps manual and quick command labels ahead of native OpenCode labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: 'Manual label',
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('Manual label')
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('Run build')
  })
})
