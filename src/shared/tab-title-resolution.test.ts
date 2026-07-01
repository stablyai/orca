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

  it('places generated titles between manual and legacy live titles when enabled', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'Refactor auth',
          title: 'Claude working',
          titleSource: 'legacy-window-fallback'
        },
        true
      )
    ).toBe('Refactor auth')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: 'Payments',
          generatedTitle: 'Refactor auth',
          title: 'Claude working',
          titleSource: 'authoritative-tab'
        },
        true
      )
    ).toBe('Payments')
  })

  it('places authoritative terminal titles before quick and generated fallback labels', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          generatedTitle: 'Refactor auth',
          title: 'Claude session title',
          titleSource: 'authoritative-tab'
        },
        true
      )
    ).toBe('Claude session title')
  })

  it('places quick command labels between manual and generated titles for legacy titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          generatedTitle: 'Refactor auth',
          title: 'pnpm test',
          titleSource: 'legacy-window-fallback'
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
          title: 'pnpm test',
          titleSource: 'authoritative-tab'
        },
        true
      )
    ).toBe('Manual label')
  })

  it('uses the same priority for unified tab labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'Fix flaky tests',
          label: 'Codex working',
          labelSource: 'legacy-window-fallback'
        },
        true
      )
    ).toBe('Fix flaky tests')
  })

  it('places authoritative unified labels before quick and generated labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'Claude session title',
          labelSource: 'authoritative-tab'
        },
        true
      )
    ).toBe('Claude session title')
  })

  it('uses quick command labels before generated unified labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'Codex working',
          labelSource: 'legacy-window-fallback'
        },
        true
      )
    ).toBe('Run build')
  })
})
