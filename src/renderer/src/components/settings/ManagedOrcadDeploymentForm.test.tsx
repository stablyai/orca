// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import { ManagedOrcadDeploymentForm } from './ManagedOrcadDeploymentForm'

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Build host',
  host: 'build.example.com',
  port: 22,
  username: 'deploy'
}

afterEach(cleanup)

function renderForm(
  preflight: React.ComponentProps<typeof ManagedOrcadDeploymentForm>['preflight'],
  onDeploy = vi.fn()
) {
  render(
    <ManagedOrcadDeploymentForm
      busyAction={null}
      error={null}
      name="Build host"
      onCancel={vi.fn()}
      onDeploy={onDeploy}
      onErrorClear={vi.fn()}
      onNameChange={vi.fn()}
      onTargetChange={vi.fn()}
      preflight={preflight}
      sshTargetId={target.id}
      targets={[target]}
    />
  )
  return onDeploy
}

describe('ManagedOrcadDeploymentForm migration preflight', () => {
  it('shows exact direct-SSH identities and blocks deployment', () => {
    const onDeploy = renderForm({
      state: 'ready',
      targetId: target.id,
      preflight: {
        targetId: target.id,
        targetLabel: target.label,
        claimable: false,
        blockers: [
          {
            code: 'orcad_migration_direct_ssh_repositories',
            category: 'drainable-static-state',
            repositories: [
              { id: 'repo-1', path: '/srv/repo', displayName: 'Remote repo', kind: 'git' }
            ]
          },
          {
            code: 'orcad_migration_direct_ssh_terminal_leases',
            category: 'live-or-unverifiable',
            terminalLeases: [{ ptyId: 'pty-1', state: 'detached', updatedAt: 42 }]
          }
        ]
      }
    })

    expect(screen.getByText('Remote repo · /srv/repo')).toBeTruthy()
    expect(screen.getByText('pty-1 · detached')).toBeTruthy()
    const deployButton = screen.getByRole('button', { name: 'Deploy' })
    expect(deployButton.hasAttribute('disabled')).toBe(true)
    const form = deployButton.closest('form')
    if (!form) {
      throw new Error('Expected Deploy to be inside the managed orcad form')
    }
    fireEvent.submit(form)
    expect(onDeploy).not.toHaveBeenCalled()
  })

  it('enables deployment only after a claimable preflight', () => {
    const onDeploy = renderForm({
      state: 'ready',
      targetId: target.id,
      preflight: {
        targetId: target.id,
        targetLabel: target.label,
        claimable: true,
        blockers: []
      }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))

    expect(onDeploy).toHaveBeenCalledWith({ name: 'Build host', sshTargetId: target.id })
  })
})
