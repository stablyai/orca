// @vitest-environment happy-dom
import type { NativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { Profiler, useContext } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  NativeChatMarkdownImageOwnerProvider,
  NativeChatMarkdownImageOwnerContext
} from './native-chat-markdown-image-owner'
import { NativeChatTextAttachmentScope } from './NativeChatTextAttachments'
import {
  useAppStore,
  IncomingOwnerReadMeter,
  incomingFilterWork,
  assertIncomingOwnerFilterBoundaries,
  restoreIncomingFilterArrays
} from './native-chat-owner-filter.test-fixture'
import {
  nativeChatFanoutFixture,
  agentSessionTabFixture,
  detectedListingFixture,
  repoFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'

vi.mock('./NativeChatTextAttachmentPreview', () => ({
  NativeChatTextAttachmentPreview: () => null
}))
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  restoreIncomingFilterArrays()
})

it('bounds routing work at 100 mounted scopes with quiet updates and exact incoming attribution', async () => {
  const n = 100
  const reads = new IncomingOwnerReadMeter()
  const ws = 'wt-0'
  const known = worktreeFixture(ws, '/own', {
    hostId: 'ssh:ssh-1',
    runtimeOwnerEnvironmentId: 'owner-a'
  })
  const detected = Array.from({ length: n }, (_, index) =>
    reads.row(
      detectedListingFixture([
        worktreeFixture(
          ws,
          index < n - 1 ? '/other' : '/own',
          index < n - 1
            ? { hostId: `runtime:other-${index}` }
            : { hostId: 'ssh:ssh-1', runtimeOwnerEnvironmentId: 'owner-a' }
        )
      ]).worktrees[0]!,
      'runtimeOwnerEnvironmentId',
      'nested'
    )
  )
  const ssh = {
    targetGenerations: new Map(),
    targetLabels: new Map(),
    removedTargetLabels: new Map(),
    targetsHydrated: true,
    connectionStates: new Map([
      [
        'ssh-1',
        {
          targetId: 'ssh-1',
          status: 'connected' as const,
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 3
        }
      ]
    ])
  }
  useAppStore.setState(
    {
      ...initial,
      ...nativeChatFanoutFixture(n, 1, 0),
      settings: getDefaultSettings('/test-home'),
      repos: [repoFixture({ executionHostId: 'runtime:owner-a' })],
      worktreesByRepo: {},
      detectedWorktreesByRepo: { repo: { ...detectedListingFixture([]), worktrees: detected } },
      folderWorkspaces: [],
      unifiedTabsByWorktree: {
        [ws]: Array.from({ length: n }, (_, i) => agentSessionTabFixture(`chat-${i}`, ws))
      },
      sshStateByEnvironment: new Map([['owner-a', ssh]]),
      activeWorktreeId: ws,
      activeWorkspaceExecutionHostId: 'runtime:owner-a'
    },
    true
  )
  let renders = 0,
    commits = 0
  const contexts: NativeChatImageRuntimeContext[] = []
  function Probe({ index }: { index: number }) {
    contexts[index] = useContext(NativeChatMarkdownImageOwnerContext)!.runtimeContext
    renders++
    return null
  }
  reads.reset()
  const view = render(
    Array.from({ length: n }, (_, index) => (
      <Profiler key={index} id={String(index)} onRender={() => commits++}>
        <NativeChatMarkdownImageOwnerProvider tabId={`chat-${index}`} sessionId={null} isVisible>
          <NativeChatTextAttachmentScope enabled>
            <Probe index={index} />
          </NativeChatTextAttachmentScope>
        </NativeChatMarkdownImageOwnerProvider>
      </Profiler>
    ))
  )
  await act(async () => {})
  const bound = () => {
    // STA-13152 nested work is excluded here; separate STA-12852 repo work is not measured.
    expect(reads.rawOperations).toBe(reads.operations + reads.nestedFilterExcluded)
    expect(reads.nestedFilterExcluded).toBe(incomingFilterWork.nestedVisits)
    expect(reads.operations).toBeLessThanOrEqual(20 * n)
    return reads.snapshot()
  }
  const cold = bound()
  expect(reads.nestedFilterExcluded).toBe(2 * n * n)
  expect(reads.operations).toBe(n + 1)
  expect(contexts.every((value) => value?.worktreePath === '/own')).toBe(true)
  const outside = reads.snapshot()
  void detected[n - 1]!.runtimeOwnerEnvironmentId
  expect(reads.operations).toBe(outside.operations + 1)
  expect(reads.nestedFilterExcluded).toBe(outside.nestedFilterExcluded)
  reads.reset()
  commits = 0
  renders = 0
  await act(async () =>
    useAppStore.setState({
      sshStateByEnvironment: new Map([
        ['owner-a', ssh],
        ['other', { ...ssh, connectionStates: new Map() }]
      ])
    })
  )
  bound()
  expect(commits).toBe(0)
  expect(renders).toBe(0)
  expect(reads.operations).toBe(0)
  reads.reset()
  commits = 0
  renders = 0
  await act(async () =>
    useAppStore.setState({
      detectedWorktreesByRepo: {
        repo: {
          ...detectedListingFixture([]),
          worktrees: [
            ...detected.slice(0, -1),
            reads.row(
              { ...detected[n - 1]!, path: '/changed' },
              'runtimeOwnerEnvironmentId',
              'nested'
            )
          ]
        }
      }
    })
  )
  const changed = bound()
  expect(commits).toBe(n)
  expect(renders).toBe(n)
  expect(contexts.every((value) => value?.worktreePath === '/changed')).toBe(true)
  console.info('attachment-routing-attribution', JSON.stringify({ n, cold, changed }))
  view.unmount()
  console.info(
    'attachment-attribution-boundaries',
    JSON.stringify(assertIncomingOwnerFilterBoundaries(reads, useAppStore.getState(), known, ws))
  )
})
