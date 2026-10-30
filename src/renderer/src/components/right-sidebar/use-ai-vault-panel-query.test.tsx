// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useAiVaultPanelQuery } from './use-ai-vault-panel-query'

type Target = Parameters<typeof useAiVaultPanelQuery>[1]

const APP_IN_ORCA: Target = {
  preferredScope: 'workspace',
  activeWorktreeId: 'repo-1::/work/app',
  activeProjectKey: 'repo:orca'
}
const DOCS_IN_ORCA = { ...APP_IN_ORCA, activeWorktreeId: 'repo-1::/work/docs' }
const SITE_IN_WEB = {
  ...APP_IN_ORCA,
  activeWorktreeId: 'repo-2::/work/site',
  activeProjectKey: 'repo:web'
}

function typed(target: Target) {
  const hook = renderHook((props: Target) => useAiVaultPanelQuery('', props), {
    initialProps: target
  })
  act(() => hook.result.current[1]('needle'))
  return hook
}

describe('useAiVaultPanelQuery', () => {
  it('clears a Workspace query when another workspace becomes active', () => {
    const hook = typed(APP_IN_ORCA)
    hook.rerender(DOCS_IN_ORCA)
    expect(hook.result.current[0]).toBe('')
  })

  it('keeps a Project query within the project and clears it in another', () => {
    const hook = typed({ ...APP_IN_ORCA, preferredScope: 'project' })
    hook.rerender({ ...DOCS_IN_ORCA, preferredScope: 'project' })
    expect(hook.result.current[0]).toBe('needle')
    hook.rerender({ ...SITE_IN_WEB, preferredScope: 'project' })
    expect(hook.result.current[0]).toBe('')
  })

  it('keeps an All query across workspaces', () => {
    const hook = typed({ ...APP_IN_ORCA, preferredScope: 'all' })
    hook.rerender({ ...SITE_IN_WEB, preferredScope: 'all' })
    expect(hook.result.current[0]).toBe('needle')
  })

  it('keeps the query when the user widens the scope', () => {
    const hook = typed(APP_IN_ORCA)
    hook.rerender({ ...APP_IN_ORCA, preferredScope: 'all' })
    expect(hook.result.current[0]).toBe('needle')
  })
})
