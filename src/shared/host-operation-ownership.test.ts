import { describe, expect, it } from 'vitest'
import {
  RPC_METHODS_WITHOUT_SHARED_PARAMS,
  RPC_PARAMS_BY_METHOD
} from './rpc-contract/rpc-params-catalog.generated'
import { getHostOperationOwnership } from './host-operation-ownership'

describe('getHostOperationOwnership', () => {
  it('classifies every runtime RPC method', () => {
    const methods = [...Object.keys(RPC_PARAMS_BY_METHOD), ...RPC_METHODS_WITHOUT_SHARED_PARAMS]
    expect(methods.filter((method) => getHostOperationOwnership(method) === null)).toEqual([])
  })

  it('reads subscriptions as streams and forge namespaces as credential-sourced', () => {
    expect(getHostOperationOwnership('terminal.subscribe')).toBe('stream')
    expect(getHostOperationOwnership('files.unwatch')).toBe('stream')
    expect(getHostOperationOwnership('session.tabs.subscribeAll')).toBe('stream')
    expect(getHostOperationOwnership('accounts.list')).toBe('host')
    expect(getHostOperationOwnership('github.prChecks')).toBe('credential')
    expect(getHostOperationOwnership('jira.getIssueStream')).toBe('scope-picked')
  })

  it('reads row-less GitHub Projects board methods as scope-picked', () => {
    expect(getHostOperationOwnership('github.project.viewTable')).toBe('scope-picked')
    expect(getHostOperationOwnership('github.project.listAccessible')).toBe('scope-picked')
    expect(getHostOperationOwnership('github.project.listViews')).toBe('scope-picked')
    expect(getHostOperationOwnership('github.project.resolveRef')).toBe('scope-picked')
    // Row edits route to the matched repo's owner first, so they stay credential-sourced.
    expect(getHostOperationOwnership('github.project.updateItemField')).toBe('credential')
  })

  it('keeps client effects client and returns null for unknown names', () => {
    expect(getHostOperationOwnership('shell.openPath')).toBe('client')
    expect(getHostOperationOwnership('nope.call')).toBeNull()
    expect(getHostOperationOwnership('accounts')).toBeNull()
    expect(getHostOperationOwnership('.list')).toBeNull()
  })
})
