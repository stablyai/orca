import type { AgentSessionSlashCommand } from './agent-session-wire'

export type CommandMenuRendererFixtureModule = {
  renderCommandMenu: (sessionId: string) => {
    commands: () => AgentSessionSlashCommand[] | null | undefined
    setOpen: (open: boolean) => void
    unmount: () => void
  }
  resetReadOwners: () => void
}
