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

  it('places generated titles between manual and status live titles when enabled', () => {
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

  it('uses a meaningful live title ahead of a generated first-prompt title', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'Upload the Kimi-K3 model to GitHub',
          title: 'Refactor auth middleware'
        },
        true
      )
    ).toBe('Refactor auth middleware')
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

  it('keeps a Codex thread name stable across activity plus project OSC titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          aiVaultTitle: {
            agent: 'codex',
            sessionId: 'codex-session',
            title: 'Repair provider-native tab titles'
          },
          title: '⠋ albacore'
        },
        false
      )
    ).toBe('Repair provider-native tab titles')
  })

  it('keeps AI Vault titles above a meaningful live title, which still beats generated', () => {
    const aiVaultTitle = {
      agent: 'codex' as const,
      sessionId: 'codex-session',
      title: 'Vault conversation'
    }
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          aiVaultTitle,
          generatedTitle: 'First prompt title',
          title: 'Investigate replay bug'
        },
        true
      )
    ).toBe('Vault conversation')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'First prompt title',
          title: 'Investigate replay bug'
        },
        true
      )
    ).toBe('Investigate replay bug')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'First prompt title',
          title: 'Claude working'
        },
        true
      )
    ).toBe('First prompt title')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'First prompt title',
          title: '⠋ Codex is thinking'
        },
        true
      )
    ).toBe('First prompt title')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'First prompt title',
          title: '⠋ - Waiting for response… - grok'
        },
        true
      )
    ).toBe('First prompt title')
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          aiVaultTitle,
          generatedLabel: 'First prompt title',
          label: 'Investigate replay bug'
        },
        true
      )
    ).toBe('Vault conversation')
  })

  it('keeps manual and quick-command labels ahead of AI Vault titles', () => {
    const aiVaultTitle = {
      agent: 'claude' as const,
      sessionId: 'claude-session',
      title: 'Claude conversation'
    }
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: 'Manual label',
          quickCommandLabel: 'Run tests',
          aiVaultTitle,
          title: 'claude working'
        },
        false
      )
    ).toBe('Manual label')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          aiVaultTitle,
          title: 'claude working'
        },
        false
      )
    ).toBe('Run tests')
  })

  it('keeps OpenCode native and Orca-generated title behavior intact', () => {
    const aiVaultTitle = {
      agent: 'codex' as const,
      sessionId: 'codex-session',
      title: 'Codex conversation'
    }
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          aiVaultTitle,
          generatedTitle: 'Orca generated',
          title: 'OC | OpenCode native'
        },
        true
      )
    ).toBe('OC | OpenCode native')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Orca generated', title: '⠋ albacore' },
        true
      )
    ).toBe('Orca generated')
  })

  it('uses the same priority for unified tab labels', () => {
    expect(
      resolveUnifiedTabLabel(
        { customLabel: null, generatedLabel: 'Fix flaky tests', label: 'Codex working' },
        true
      )
    ).toBe('Fix flaky tests')
  })

  it('uses a meaningful live unified label ahead of a generated label', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'Upload the Kimi-K3 model to GitHub',
          label: 'Refactor auth middleware'
        },
        true
      )
    ).toBe('Refactor auth middleware')
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
