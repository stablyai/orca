// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { SshEgressIndicator } from './browser-egress-indicator'

const WORKSPACE = 'repo1::/repo'
const initialState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(
    {
      ...initialState,
      settings: {
        ...getDefaultSettings('/home/test'),
        browserSshWorkspaceRoutingDisabledTargetIds: ['box'],
        hostSettingOverrides: { 'runtime:env-box': { displayLabel: 'Build box' } }
      },
      sshTargetLabels: new Map(),
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKSPACE,
            repoId: 'repo1',
            path: '/repo',
            hostId: 'runtime:env-box',
            runtimeOwnerEnvironmentId: 'env-box'
          })
        ]
      },
      runtimeEnvironments: [
        {
          id: 'env-box',
          name: 'Box',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [
            { id: 'ws', kind: 'websocket', label: 'Box', endpoint: 'ws://127.0.0.1:46768/' }
          ],
          preferredEndpointId: 'ws',
          orcadDeployment: {
            sshTargetId: 'box',
            sshTargetGeneration: 1,
            localPort: 46_768,
            remotePort: 6_768
          }
        }
      ]
    },
    true
  )
})

afterEach(cleanup)

it('shows device browsing for a managed SSH workspace that opts out of SSH routing', () => {
  render(
    <TooltipProvider>
      <SshEgressIndicator worktreeId={WORKSPACE} />
    </TooltipProvider>
  )

  const indicator = screen.getByTestId('ssh-egress-indicator')
  expect(indicator.getAttribute('data-egress')).toBe('local')
  expect(indicator.getAttribute('aria-label')).toBe('Browsing from this device, not Build box')
})
