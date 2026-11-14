import type { AiVaultSession } from './ai-vault/contracts/ai-vault-types'
import { antigravitySessionOrigin } from './antigravity-session-origin'
import { sessionFileExecutionNamespace } from './ai-vault/scanning/ai-vault-scope-cwd-match'

export function sessionAliasKey(session: AiVaultSession): string | null {
  if (session.agent === 'antigravity') {
    const root = session.filePath
      .split(/[\\/]+/)
      .slice(0, -4)
      .join('/')
    return `antigravity\0${session.executionHostId}\0${antigravitySessionOrigin(session.filePath) ?? 'cli'}\0${root}\0${session.sessionId}`
  }
  if (session.agent !== 'devin') {
    const codexKey = codexSessionAliasKey(session)
    return codexKey ? `codex\0${codexKey}` : null
  }
  // Sibling exports share an index; different installs and WSL distros do not.
  const cliDir = session.filePath.split(/[\\/]/).slice(0, -2).join('/')
  return `devin\0${session.executionHostId}\0${cliDir}\0${session.sessionId}`
}

export function codexSessionAliasKey(session: AiVaultSession): string | null {
  if (session.agent !== 'codex') {
    return null
  }
  const physicalName = session.filePath.split(/[\\/]/).at(-1) ?? ''
  const fileName = physicalName.endsWith('.zst') ? physicalName.slice(0, -4) : physicalName
  if (!/^rollout-.+\.jsonl$/.test(fileName)) {
    return null
  }
  return `${session.executionHostId}\0${sessionFileExecutionNamespace(session.filePath)}\0${session.sessionId}\0${fileName}`
}
