import { describe, expect, it } from 'vitest'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../../shared/tab-title-resolution'
import type { Tab, TerminalTab } from '../../../../shared/types'

// Why: useTabGroupWorkspaceModel rebuilds the terminal tab field-by-field from
// the unified tab plus the store tab, and the tab strip resolves the label from
// that rebuild. `agentRenamedTitle` is optional, so dropping it here type-checks
// and silently hands the label back to the generated title — every resolver test
// still passes. Mirror the merge and assert the field survives it.
function projectTerminalTab(
  item: Partial<Tab>,
  terminalTab: Partial<TerminalTab> | undefined
): Partial<TerminalTab> {
  return {
    quickCommandLabel: terminalTab?.quickCommandLabel ?? item.quickCommandLabel ?? null,
    generatedTitle: terminalTab?.generatedTitle ?? item.generatedLabel ?? null,
    agentRenamedTitle: terminalTab?.agentRenamedTitle ?? item.agentRenamedLabel ?? null,
    customTitle: item.customLabel ?? terminalTab?.customTitle ?? null,
    title: resolveUnifiedTabLabel(
      {
        ...(item as Tab),
        quickCommandLabel: item.quickCommandLabel ?? terminalTab?.quickCommandLabel,
        generatedLabel: item.generatedLabel ?? terminalTab?.generatedTitle,
        agentRenamedLabel: item.agentRenamedLabel ?? terminalTab?.agentRenamedTitle
      },
      true,
      item.label
    )
  }
}

const STORE_TAB: Partial<TerminalTab> = {
  generatedTitle: 'What is 2 2',
  agentRenamedTitle: 'billing-fix',
  customTitle: null
}

describe('terminal tab rename projection', () => {
  it('carries the agent rename through the tab-strip rebuild', () => {
    const projected = projectTerminalTab({ customLabel: null, label: '✳ billing-fix' }, STORE_TAB)

    expect(projected.agentRenamedTitle).toBe('billing-fix')
    expect(projected.title).toBe('✳ billing-fix')
    expect(
      resolveTerminalTabTitle({ ...projected, title: '✳ billing-fix' } as TerminalTab, true)
    ).toBe('✳ billing-fix')
  })

  it('takes the rename from the unified tab when only it carries one', () => {
    const projected = projectTerminalTab(
      { customLabel: null, label: '✳ billing-fix', agentRenamedLabel: 'billing-fix' },
      { generatedTitle: 'What is 2 2', customTitle: null }
    )

    expect(projected.agentRenamedTitle).toBe('billing-fix')
    expect(projected.title).toBe('✳ billing-fix')
  })

  it('keeps the generated title when the agent only auto-summarized', () => {
    const projected = projectTerminalTab(
      { customLabel: null, label: '✳ Answer simple arithmetic question' },
      { ...STORE_TAB, agentRenamedTitle: null }
    )

    expect(projected.title).toBe('What is 2 2')
  })
})
