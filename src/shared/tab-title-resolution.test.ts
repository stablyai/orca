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

  it('lets a deliberate in-agent rename win after the first prompt', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'What is 2 2',
          title: '✳ billing-fix',
          agentRenamedTitle: 'billing-fix'
        },
        true
      )
    ).toBe('✳ billing-fix')
  })

  it('keeps generated titles ahead of the agent auto-generated summary', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'What is 2 2',
          title: '✳ Answer simple arithmetic question',
          agentRenamedTitle: 'billing-fix'
        },
        true
      )
    ).toBe('What is 2 2')
  })

  it('keeps manual and quick command titles ahead of an in-agent rename', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: 'Payments',
          quickCommandLabel: 'Run tests',
          generatedTitle: 'What is 2 2',
          title: '✳ billing-fix',
          agentRenamedTitle: 'billing-fix'
        },
        true
      )
    ).toBe('Payments')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          generatedTitle: 'What is 2 2',
          title: '✳ billing-fix',
          agentRenamedTitle: 'billing-fix'
        },
        true
      )
    ).toBe('Run tests')
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

  it('lets a deliberate in-agent rename win for unified labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'What is 2 2',
          label: '✳ billing-fix',
          agentRenamedLabel: 'billing-fix'
        },
        true
      )
    ).toBe('✳ billing-fix')
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'What is 2 2',
          label: '✳ Answer simple arithmetic question',
          agentRenamedLabel: 'billing-fix'
        },
        true
      )
    ).toBe('What is 2 2')
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
