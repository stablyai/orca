// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AiVaultPanelHeader } from './AiVaultPanelHeader'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key]))
}))
vi.mock('./AiVaultPanelControls', () => ({
  VaultHostScopeMenu: () => null,
  VaultScopeSwitch: () => null,
  VaultViewMenu: () => null
}))

afterEach(cleanup)

function header(focusSearchRequestId: number) {
  return render(
    <AiVaultPanelHeader
      query=""
      loading={false}
      hasScanResult={false}
      activeWorktreePath={null}
      activeProjectKey={null}
      scope="all"
      executionHostScope="local"
      hostScopeOptions={[]}
      agents={[]}
      group="project"
      hideEmptySessions={false}
      sessionLimit={250}
      adjustmentCount={0}
      focusSearchRequestId={focusSearchRequestId}
      onQueryChange={vi.fn()}
      onScopeChange={vi.fn()}
      onExecutionHostScopeChange={vi.fn()}
      onAgentEnabledChange={vi.fn()}
      onAllAgentsEnabledChange={vi.fn()}
      onGroupChange={vi.fn()}
      onHideEmptySessionsChange={vi.fn()}
      onSessionLimitChange={vi.fn()}
      onReset={vi.fn()}
      onRefresh={vi.fn()}
    />
  )
}

it('leaves focus alone until someone asks for the search box', () => {
  header(0)
  expect(screen.getByRole('textbox', { name: 'Search sessions' })).not.toHaveFocus()
})

it('focuses the search box when Settings sends the user here', () => {
  header(1)
  expect(screen.getByRole('textbox', { name: 'Search sessions' })).toHaveFocus()
})
