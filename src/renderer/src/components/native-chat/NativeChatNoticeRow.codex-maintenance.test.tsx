// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'

import { renderStatus } from './native-chat-notice-row.test-fixture'

afterEach(cleanup)

describe('Codex installation in notice rows', () => {
  it.each([null, '0.135.0'])(
    'shows the shared notice on a resumed Codex failure without a button: %s',
    (installedVersion) => {
      const failure: AgentSessionFailureFact = {
        kind: 'startFailed',
        refusal: {
          code: 'agent_session_operation_invalid',
          details: {
            reason: 'attachFailed',
            codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
          }
        }
      }
      const text = installedVersion
        ? 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.'
        : "Codex isn't installed."
      renderStatus(
        {
          kind: 'status',
          tone: 'error',
          ...agentSessionFailureWords(failure, { agentName: 'Codex', surface: 'row' })
        },
        null,
        false,
        'Codex',
        { key: 'codex', kind: 'error', text }
      )
      expect(screen.getByText(text)).toBeInTheDocument()
      expect(screen.queryByRole('button')).toBeNull()
    }
  )
})
