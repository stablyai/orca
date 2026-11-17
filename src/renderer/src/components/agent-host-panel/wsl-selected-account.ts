// WSL rows name the account selected for that distro in Accounts. Read from this
// computer's settings (the selection the desktop pushes to the distro), never from the distro, so a
// stopped distro is never started to answer.
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'

type Selection = { wsl: Readonly<Record<string, string | null>> }
type Account = { id: string; email: string }

/** The slice of GlobalSettings this reads. */
type AccountSettings = {
  claudeManagedAccounts?: readonly Account[]
  activeClaudeManagedAccountIdsByRuntime?: Selection
  codexManagedAccounts?: readonly Account[]
  activeCodexManagedAccountIdsByRuntime?: Selection
}

function selectedId(selection: Selection | undefined, distro: string): string | null {
  const wanted = distro.trim().toLowerCase()
  for (const [key, id] of Object.entries(selection?.wsl ?? {})) {
    if (key.trim().toLowerCase() === wanted && id) {
      return id
    }
  }
  return null
}

/** Each agent's selected account for this distro, as its email; null where none is selected. */
export function wslSelectedAccounts(
  settings: AccountSettings | null | undefined,
  distro: string | null
): Record<HostAgentSignInAgent, string | null> {
  if (!settings || !distro) {
    return { claude: null, codex: null }
  }
  const claudeId = selectedId(settings.activeClaudeManagedAccountIdsByRuntime, distro)
  const codexId = selectedId(settings.activeCodexManagedAccountIdsByRuntime, distro)
  return {
    claude:
      (claudeId &&
        settings.claudeManagedAccounts?.find((account) => account.id === claudeId)?.email) ||
      null,
    codex:
      (codexId &&
        settings.codexManagedAccounts?.find((account) => account.id === codexId)?.email) ||
      null
  }
}
