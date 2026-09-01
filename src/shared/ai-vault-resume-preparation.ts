import type { AiVaultSession } from './ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from './execution-host'

export type AiVaultPrepareSessionResumeArgs = Pick<
  AiVaultSession,
  'agent' | 'filePath' | 'codexHome' | 'executionHostId'
> &
  Partial<Pick<AiVaultSession, 'sessionId'>>

export type AiVaultPrepareSessionResumeResult = {
  useRealCodexHome: boolean
  // Why: cross-account hardlinking lists one rollout under several per-account
  // homes, so the owning host repins resume to the selected account's home.
  // Absent (older hosts included) means resume keeps the session's own home.
  substituteCodexHome?: string
}

export type AiVaultSessionResumePreparation = (
  args: AiVaultPrepareSessionResumeArgs
) => Promise<AiVaultPrepareSessionResumeResult>

const LEGACY_MOBILE_PREPARATION_FORBIDDEN_MESSAGE =
  "Method 'aiVault.prepareSessionResume' is not available to mobile clients"

export function isAiVaultPrepareSessionResumeUnavailableError(error: {
  code: string
  message: string
}): boolean {
  return (
    error.code === 'method_not_found' ||
    (error.code === 'forbidden' && error.message === LEGACY_MOBILE_PREPARATION_FORBIDDEN_MESSAGE)
  )
}

export function isLegacySharedCodexHome(codexHome: string | null): boolean {
  if (!codexHome) {
    return false
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  return segments.at(-2) === 'codex-runtime-home' && segments.at(-1) === 'home'
}

/** Matches the managed `codex-accounts/<id>/home` layout, mirroring the AI Vault scan-root shape check. */
export function isPerAccountManagedCodexHome(codexHome: string | null): boolean {
  if (!codexHome) {
    return false
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  return segments.at(-3) === 'codex-accounts' && segments.at(-1) === 'home'
}

/** Codex is the only agent whose resume home is repinned, and only for a
 *  legacy shared home or a per-account managed home. Per-account repinning
 *  reads the LOCAL account selection, so only local sessions ask. */
export function aiVaultSessionNeedsResumePreparation(
  session: Pick<AiVaultSession, 'agent' | 'codexHome' | 'executionHostId'>
): boolean {
  if (session.agent !== 'codex') {
    return false
  }
  if (isLegacySharedCodexHome(session.codexHome)) {
    return true
  }
  return (
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  )
}

/** Repin a freshly discovered session onto the home the owning host chose.
 *  Runs on the HOST: the resume entry carries identity only, so a client-side
 *  repin cannot reach the host that rebuilds the command from its own scan. */
export async function applyAiVaultResumePreparation<
  S extends Pick<AiVaultSession, 'agent' | 'filePath' | 'codexHome' | 'executionHostId'>
>(session: S, prepare: AiVaultSessionResumePreparation | undefined): Promise<S> {
  if (!prepare || !aiVaultSessionNeedsResumePreparation(session)) {
    return session
  }
  const result = await prepare({
    agent: session.agent,
    filePath: session.filePath,
    codexHome: session.codexHome,
    executionHostId: session.executionHostId
  })
  if (result.useRealCodexHome) {
    return { ...session, codexHome: null }
  }
  if (result.substituteCodexHome) {
    return { ...session, codexHome: result.substituteCodexHome }
  }
  return session
}

/** The env names a real-home Codex resume must strip. A per-account or legacy
 *  home is passed explicitly, so only the repinned-to-real-home case clears. */
export function aiVaultResumeClearEnvNames(
  session: Pick<AiVaultSession, 'agent' | 'codexHome'>
): readonly string[] | undefined {
  return session.agent === 'codex' && session.codexHome === null
    ? (['CODEX_HOME', 'ORCA_CODEX_HOME'] as const)
    : undefined
}
