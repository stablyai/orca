import type { AgentSessionSlashCommand } from './agent-session/agent-session-wire'

export type CommandMenuRendererFixtureModule = {
  renderCommandMenu: (sessionId: string) => {
    commands: () => AgentSessionSlashCommand[] | null | undefined
    setOpen: (open: boolean) => void
    unmount: () => void
  }
  resetReadOwners: () => void
}
