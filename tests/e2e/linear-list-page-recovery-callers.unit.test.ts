import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { runLinearListIssues } from '../../src/cli/handlers/linear-list-issues'
import type { RuntimeClient } from '../../src/cli/runtime-client'
import { RuntimeRpcFailureError } from '../../src/cli/runtime/types'
import { formatCliError } from '../../src/cli/cli-error'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { defineMethod } from '../../src/main/runtime/rpc/core'
import { LINEAR_MCP_ISSUE_LIST_METHOD } from '../../src/main/runtime/rpc/methods/linear-issue-list-method'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { dispatchRemoteLinearListIssues } from '../../src/main/ssh/ssh-remote-linear-list-issues'
import { formatRemoteCli } from '../../src/main/ssh/ssh-remote-cli-format'

afterEach(() => vi.restoreAllMocks())
const result = {
  issues: [],
  truncated: false,
  meta: {
    limit: null,
    returned: 0,
    hasMore: false,
    orderBy: 'updatedAt',
    workspaceId: 'all',
    partial: false,
    workspaceErrors: []
  }
}

describe('actual CLI/SSH capability negotiation against strict schema skew', () => {
  it.each(['cli', 'ssh'] as const)(
    'omits the option for an unadvertised host and negotiates a new host through %s',
    async (route) => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      for (const capable of [false, true]) {
        const read = vi.fn().mockResolvedValue(result)
        const runtime = {
          getRuntimeId: () => (capable ? 'new-owner' : 'old-owner'),
          linearMcpIssueList: read
        } as unknown as OrcaRuntimeService
        // The pinned old method has the same strict fields except pageRecovery.
        const oldSchema = (LINEAR_MCP_ISSUE_LIST_METHOD.params as z.ZodObject).omit({
          pageRecovery: true
        })
        const method = capable
          ? LINEAR_MCP_ISSUE_LIST_METHOD
          : { ...LINEAR_MCP_ISSUE_LIST_METHOD, params: oldSchema }
        const status = defineMethod({
          name: 'linear.status',
          params: null,
          handler: () => ({
            connected: true,
            viewer: null,
            ...(capable ? { mcpListPageRecoveryVersion: 1 } : {})
          })
        })
        const dispatcher = new RpcDispatcher({ runtime, methods: [method, status] })
        const calls: string[] = []
        const client = {
          call: async (name: string, params: unknown) => {
            calls.push(name)
            const response = await dispatcher.dispatch({
              id: 'fixture',
              authToken: 'synthetic',
              method: name,
              params: JSON.parse(JSON.stringify(params))
            })
            if (!response.ok) {
              throw new RuntimeRpcFailureError(response)
            }
            return response
          }
        } as unknown as RuntimeClient
        const flags = new Map<string, string | boolean>([['workspace', 'all']])
        if (route === 'cli') {
          await runLinearListIssues({ flags, client, cwd: '/folder-without-git', json: true })
          expect(calls).toEqual(['linear.status', 'linear.mcpListIssues'])
        } else {
          expect(
            (
              await dispatchRemoteLinearListIssues(dispatcher, {
                commandPath: ['linear', 'list-issues'],
                flags
              })
            ).ok
          ).toBe(true)
        }
        expect(read).toHaveBeenCalledOnce()
        expect(read.mock.calls[0][0].limit).toBeUndefined()
        expect(read.mock.calls[0][0].pageRecovery).toEqual(capable ? { version: 1 } : undefined)
        if (!capable) {
          const refused = await dispatcher.dispatch({
            id: 'fixture',
            authToken: 'synthetic',
            method: 'linear.mcpListIssues',
            params: { workspaceId: 'all', pageRecovery: { version: 1 } }
          })
          expect(refused.ok).toBe(false)
        }
      }
    }
  )
  it('keeps error-carried recovery through the client exception and both human formatters', () => {
    const failure = {
      id: 'fixture',
      ok: false as const,
      _meta: { runtimeId: 'owner' },
      error: {
        code: 'linear_timeout',
        message: 'Linear listing deadline reached.',
        data: { pageRecovery: { version: 1, continuation: 'YWJj' } }
      }
    }
    const error = new RuntimeRpcFailureError(failure)
    expect(error.response.error.data).toEqual(failure.error.data)
    expect(formatCliError(error)).toContain('--page-recovery YWJj')
    expect(formatRemoteCli(failure).stderr).toContain('--page-recovery YWJj')
  })
  it('refuses vector and concrete-cursor combination before contacting any host', async () => {
    const call = vi.fn()
    await expect(
      runLinearListIssues({
        flags: new Map([
          ['workspace', 'all'],
          ['cursor', 'v1'],
          ['page-recovery', 'YWJj']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/folder',
        json: true
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
