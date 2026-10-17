// @vitest-environment happy-dom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../../../shared/integration-credential-errors'
import { Command } from '@/components/ui/command'
import { SmartWorkspaceSourceResultList } from './SmartWorkspaceSourceResultList'
import type { JiraUrlSourceState } from './use-jira-url-source'

const decryptMessage = credentialDecryptionMessage('Linear')

function linearResultModel(
  credentialError?: string
): React.ComponentProps<typeof SmartWorkspaceSourceResultList>['model'] {
  const jiraSource: JiraUrlSourceState = {
    intent: false,
    loading: false,
    issue: null,
    boundSourceContext: null,
    accountChoices: [],
    errorKind: null,
    selectAccount: () => {},
    retry: () => {}
  }
  return {
    mode: 'linear',
    mrStateFilters: [],
    mrStateFilter: 'opened',
    setMrStateFilter: () => {},
    typedTextActionRow: null,
    jiraSource,
    loading: false,
    searchResultRows: [],
    linearStatusChecked: true,
    linearStatus: { connected: true, viewer: null, credentialError },
    linearSourceContext: null,
    showJiraSiteContext: false,
    jiraConnectionStatus: null,
    reserveLinearLoadingResults: false,
    showLinearUrlLoadingFeedback: false
  }
}

describe('SmartWorkspaceSourceResultList Linear credential errors', () => {
  it('shows the decrypt message and Settings instead of the empty search hint', () => {
    const onOpenLinearSettings = vi.fn()
    render(
      <Command>
        <SmartWorkspaceSourceResultList
          model={linearResultModel(decryptMessage)}
          onSelect={() => {}}
          onOpenLinearSettings={onOpenLinearSettings}
        />
      </Command>
    )

    expect(screen.getByText(decryptMessage)).toBeTruthy()
    expect(screen.queryByText('Start typing to search Linear issues.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenLinearSettings).toHaveBeenCalledOnce()
  })

  it('keeps the empty search hint when Linear is connected and the credential can be read', () => {
    render(
      <Command>
        <SmartWorkspaceSourceResultList model={linearResultModel()} onSelect={() => {}} />
      </Command>
    )

    expect(screen.getByText('Start typing to search Linear issues.')).toBeTruthy()
  })
})
