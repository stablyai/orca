// @vitest-environment happy-dom

import type React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Command } from '@/components/ui/command'
import { SmartWorkspaceSourceResultList } from './SmartWorkspaceSourceResultList'

type Model = React.ComponentProps<typeof SmartWorkspaceSourceResultList>['model']

function renderList(refreshingResults: boolean): HTMLElement {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only these fields.
  const model = {
    mode: 'linear',
    mrStateFilters: [],
    mrStateFilter: 'opened',
    setMrStateFilter: () => {},
    typedTextActionRow: null,
    jiraSource: { errorKind: null, intent: null },
    loading: refreshingResults,
    searchResultRows: [
      {
        kind: 'branch',
        value: 'branch-main',
        refName: 'main',
        localBranchName: 'main'
      }
    ],
    linearStatusChecked: true,
    linearStatus: { connected: true },
    showJiraSiteContext: false,
    jiraConnectionStatus: null,
    reserveLinearLoadingResults: false,
    showLinearUrlLoadingFeedback: false,
    refreshingResults
  } as unknown as Model
  const { container } = render(
    <Command>
      <SmartWorkspaceSourceResultList model={model} onSelect={() => {}} />
    </Command>
  )
  return container
}

describe('SmartWorkspaceSourceResultList', () => {
  afterEach(cleanup)

  it('dims retained rows while a refresh is pending', () => {
    const group = renderList(true).querySelector('[aria-busy]')
    expect(group?.getAttribute('aria-busy')).toBe('true')
    expect(group?.className).toContain('opacity-60')
  })

  it('shows rows at full opacity once results settle', () => {
    const group = renderList(false).querySelector('[aria-busy]')
    expect(group?.getAttribute('aria-busy')).toBe('false')
    expect(group?.className).not.toContain('opacity-60')
  })
})
