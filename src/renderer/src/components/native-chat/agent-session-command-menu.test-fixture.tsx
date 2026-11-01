import { renderHook } from '@testing-library/react'
import type { CommandMenuRendererFixtureModule } from '../../../../shared/agent-session-command-menu.test-fixture-contract'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import { useStructuredAgentSessionCommandMenu } from './structured-agent-session-command-refresh'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'

export const resetReadOwners: CommandMenuRendererFixtureModule['resetReadOwners'] =
  resetStructuredAgentSessionReadOwnersForTests

export const renderCommandMenu: CommandMenuRendererFixtureModule['renderCommandMenu'] = (
  sessionId
) => {
  const target = { kind: 'local' } as const
  const hook = renderHook(() => ({
    read: useStructuredAgentSessionRead({ sessionId, target, isViewed: false }),
    menu: useStructuredAgentSessionCommandMenu(target, sessionId, true)
  }))
  return {
    commands: () => hook.result.current.read.state.commands,
    setOpen: (open) => hook.result.current.menu.setOpen(open),
    unmount: hook.unmount
  }
}
