// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WslMoveResultBody } from './WslMoveResultBody'

afterEach(cleanup)

describe('WslMoveResultBody', () => {
  it('names the projects a move left because their drive points elsewhere now', () => {
    render(
      <WslMoveResultBody
        distro="Ubuntu"
        result={{
          outcome: 'moved',
          migrationId: 'move-1',
          phase: 'retained',
          reloadRequired: true,
          droppedForMappedDrives: [{ kind: 'repo', id: 'repo-w', name: 'other' }]
        }}
        blockers={[]}
        reload="idle"
        onReload={vi.fn()}
        onReview={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('wsl-move-dropped-for-drives')).toHaveTextContent(
      'no longer points into Ubuntu: other'
    )
  })
})
