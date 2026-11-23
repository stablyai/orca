// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { AzureDevOpsBoardArea } from '@/components/task-page/azure-devops/Content'

afterEach(() => cleanup())

describe('AzureDevOpsBoardArea', () => {
  it('shows the host-unreachable notice, not a raw message, when contact was lost', () => {
    render(
      <AzureDevOpsBoardArea
        board={null}
        boardErrorStatus="host-unreachable"
        boardErrorMessage="azure_devops_repo_unverifiable"
      />
    )
    expect(screen.getByText(/Couldn’t reach the host/)).toBeInTheDocument()
    expect(screen.queryByText(/azure_devops_repo_unverifiable/)).toBeNull()
  })

  it('shows the not-an-Azure-remote notice for that status', () => {
    render(
      <AzureDevOpsBoardArea
        board={null}
        boardErrorStatus="not-azure-remote"
        boardErrorMessage="azure_devops_remote_required"
      />
    )
    expect(screen.getByText(/does not have an Azure DevOps remote/)).toBeInTheDocument()
  })

  it('shows the board load failure with its message for an ordinary error', () => {
    render(
      <AzureDevOpsBoardArea board={null} boardErrorStatus="error" boardErrorMessage="HTTP 500" />
    )
    expect(screen.getByText(/Couldn’t load the Azure DevOps board: HTTP 500/)).toBeInTheDocument()
  })

  it('spins while the board is still loading', () => {
    const { container } = render(
      <AzureDevOpsBoardArea board={null} boardErrorStatus={null} boardErrorMessage={null} />
    )
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })
})
