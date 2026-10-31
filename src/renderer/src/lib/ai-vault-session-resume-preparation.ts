import { AiVaultChatForkSourceSchema } from '../../../shared/ai-vault-chat-fork-contract'
import type { AiVaultAgent, AiVaultSession } from '../../../shared/ai-vault-types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareChatForkArgs,
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault-resume-preparation'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../shared/ai-vault-resume-preparation'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  parseRoutableExecutionHostId
} from '../../../shared/execution-host'
import { browseRuntimeServerDirectory } from '@/runtime/runtime-server-directory-browser'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { FilesystemPathFlavor } from '../../../shared/filesystem-entry-types'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { readIpcErrorMessage } from './ipc-error'
import type { AiVaultResumeCommandSession } from './ai-vault-resume-command'
import { agentForksThroughChat } from '../../../shared/agent-resume-argv'
import { translate } from '@/i18n/i18n'

export function prepareAiVaultSessionForResume(session: AiVaultSession): Promise<AiVaultSession> {
  return session.structuredSession || !aiVaultSessionNeedsResumePreparation(session)
    ? Promise.resolve(session)
    : prepareAiVaultSessionHome(session, false)
}

export function prepareAiVaultSessionForTerminalResume(
  session: AiVaultSession
): Promise<AiVaultSession> {
  return prepareAiVaultSessionHome(session, false, true)
}

export function prepareAiVaultSessionResumeRequest(
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult> {
  return window.api.aiVault.prepareSessionResume(args)
}

export async function prepareAiVaultTerminalResumeRequest(
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult> {
  const needsHomePreparation = aiVaultSessionNeedsResumePreparation(args)
  try {
    // Why: this request checks ownership; old desktop resumes kept the recorded home otherwise.
    const result = await prepareAiVaultSessionResumeRequest(
      needsHomePreparation ? args : { ...args, codexHome: null }
    )
    if (
      typeof result?.useRealCodexHome !== 'boolean' ||
      (result.substituteCodexHome !== undefined && typeof result.substituteCodexHome !== 'string')
    ) {
      throw new Error('Invalid aiVault.prepareSessionResume response')
    }
    return needsHomePreparation ? result : { useRealCodexHome: false }
  } catch (error) {
    if (
      !args.fork &&
      parseExecutionHostId(args.executionHostId)?.kind === 'runtime' &&
      !needsHomePreparation &&
      isMissingPairedResumePreparation(error)
    ) {
      return { useRealCodexHome: false }
    }
    throw error
  }
}

function isMissingPairedResumePreparation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const desktopPrepareError =
    error.message.startsWith("Error invoking remote method 'aiVault:prepareSessionResume':") ||
    error.message.startsWith("Error occurred in handler for 'aiVault:prepareSessionResume':")
  return (
    (desktopPrepareError &&
      readIpcErrorMessage(error) === 'aiVault.prepareSessionResume: method_not_found') ||
    ('code' in error &&
      error.code === 'method_not_found' &&
      error.message === 'Unknown method: aiVault.prepareSessionResume')
  )
}

/** Prepare Switch to Terminal under the chosen account. CLI-forking agents copy at launch (copied:false); chat-forking agents need a host-created independent copy first (copied:true). */
type ForkPreparationRequest = (
  args: AiVaultPrepareSessionResumeRequest
) => Promise<AiVaultPrepareSessionResumeResult>

export function prepareAiVaultSessionForFork(
  session: AiVaultSession,
  request?: ForkPreparationRequest
): Promise<{ session: AiVaultSession; copied: boolean }>
export function prepareAiVaultSessionForFork(
  session: AiVaultPrepareChatForkArgs,
  request?: ForkPreparationRequest
): Promise<{ session: AiVaultResumeCommandSession; copied: boolean; sourceAgent?: AiVaultAgent }>
export async function prepareAiVaultSessionForFork(
  session: AiVaultSession | AiVaultPrepareChatForkArgs,
  request: ForkPreparationRequest = (args) => window.api.aiVault.prepareSessionResume(args)
): Promise<{ session: AiVaultResumeCommandSession; copied: boolean; sourceAgent?: AiVaultAgent }> {
  if ('sourceChat' in session) {
    const result = await request(session)
    const source = AiVaultChatForkSourceSchema.parse(result.cliForkSource)
    return {
      session: {
        ...source,
        executionHostId:
          parseExecutionHostId(session.executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID
      },
      sourceAgent: source.sourceAgent,
      copied: result.forkedSession !== undefined
    }
  }
  if (!agentForksThroughChat(session.agent)) {
    return {
      session: await prepareAiVaultSessionHome(session, true, false, request),
      copied: false
    }
  }
  const result = await request({
    agent: session.agent,
    sessionId: session.sessionId,
    filePath: session.filePath,
    codexHome: session.codexHome,
    executionHostId: session.executionHostId,
    fork: true
  })
  if (!result.forkedSession || (session.agent === 'omp' && !result.forkedSession.filePath)) {
    // A host that predates chat copies makes none; resuming the chat's own would be a second writer.
    throw new Error(aiVaultCliForkHostTooOldMessage())
  }
  const { structuredSession: _owner, ...copy } = session
  const { sessionId, agent, filePath } = result.forkedSession
  return {
    session: { ...copy, agent, sessionId, filePath: filePath ?? '', resumeCommand: '' },
    copied: true
  }
}

/** Only a host that predates a fork refuses or ignores it, so the failure asks for the update. */
export function aiVaultCliForkHostTooOldMessage(): string {
  return translate(
    'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliHostTooOld',
    'Update Orca on the host that runs this chat to resume it in a new CLI.'
  )
}

async function prepareAiVaultSessionHome(
  session: AiVaultSession,
  fork: boolean,
  terminalResume = false,
  request: ForkPreparationRequest = (args) => window.api.aiVault.prepareSessionResume(args)
): Promise<AiVaultSession> {
  if (fork && !aiVaultSessionNeedsResumePreparation(session)) {
    return session
  }
  const args: AiVaultPrepareSessionResumeArgs = {
    agent: session.agent,
    sessionId: session.sessionId,
    filePath: session.filePath,
    codexHome: session.codexHome,
    executionHostId: session.executionHostId,
    ...(fork ? { fork: true } : {})
  }
  const result = await (terminalResume ? prepareAiVaultTerminalResumeRequest(args) : request(args))
  if (result.useRealCodexHome) {
    return { ...session, codexHome: null }
  }
  if (result.substituteCodexHome) {
    return { ...session, codexHome: result.substituteCodexHome }
  }
  return session
}

export function aiVaultSessionNeedsResumePreparation(
  session: Pick<AiVaultSession, 'agent' | 'codexHome' | 'executionHostId'>
): boolean {
  if (session.agent !== 'codex') {
    return false
  }
  if (isLegacySharedCodexHome(session.codexHome)) {
    return true
  }
  // Only local sessions may repin from this client’s account selection; remote sessions retain their recorded home.
  return (
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  )
}

// Kimi is folder-keyed: wrong cwd rejects resume or silently opens an empty same-ID session (1.52+).
const RESUMES_ONLY_IN_RECORDED_CWD: ReadonlySet<AiVaultSession['agent']> = new Set(['kimi', 'muse'])

/** After the session's remote host confirms missing cwd, drop it and its prebuilt cd command so resume starts at the workspace root (#17745, #26509). */
export async function dropDeletedRemoteResumeCwd(
  session: AiVaultResumeCommandSession
): Promise<AiVaultResumeCommandSession> {
  const host = parseRoutableExecutionHostId(session.executionHostId)
  const cwd = session.cwd
  if (
    (host?.kind !== 'ssh' && host?.kind !== 'runtime') ||
    !cwd ||
    RESUMES_ONLY_IN_RECORDED_CWD.has(session.agent)
  ) {
    return session
  }
  let hostFlavor: FilesystemPathFlavor | null = null
  try {
    if (host.kind === 'ssh') {
      if (await window.api.fs.pathExists({ filePath: cwd, connectionId: host.targetId })) {
        return session
      }
    } else {
      hostFlavor = await runtimeServerFolderMissingFlavor(host.environmentId, cwd)
      if (!hostFlavor) {
        return session
      }
    }
  } catch {
    // Why: only a definite ENOENT proves the folder is gone; losing the host proves nothing.
    return session
  }
  const { resumeCommand: _scannerCommand, ...rest } = session
  // The rebuilt command must quote for the host's shell; an unstamped row would otherwise build POSIX.
  return hostFlavor === 'win32' && !rest.executionHostPlatform
    ? { ...rest, cwd: null, executionHostPlatform: 'win32' }
    : { ...rest, cwd: null }
}

/** The host's path flavor when it proves `cwd` is gone, else null. files.stat needs the deleted workspace, so browse instead. */
async function runtimeServerFolderMissingFlavor(
  environmentId: string,
  cwd: string
): Promise<FilesystemPathFlavor | null> {
  // The browser trims, expands `~` and resolves relative paths, so it would probe another folder; keep those.
  if (cwd.trim() !== cwd || (!cwd.startsWith('/') && !isWindowsAbsolutePathLike(cwd))) {
    return null
  }
  try {
    await browseRuntimeServerDirectory(environmentId, cwd)
    return null
  } catch (error) {
    if (!isDefiniteMissingPathError(error)) {
      throw error
    }
  }
  // A WSL session on a Windows host records a Linux cwd the host cannot stat; absence there proves nothing.
  const flavor = await runtimeServerPathFlavor(environmentId)
  return flavor === aiVaultCwdPathFlavor(cwd) ? flavor : null
}

function isDefiniteMissingPathError(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    error.code === 'runtime_error' &&
    /^(?:ENOENT|ENOTDIR):/.test(error.message)
  )
}

const runtimeServerPathFlavors = new Map<string, Promise<FilesystemPathFlavor>>()

function runtimeServerPathFlavor(environmentId: string): Promise<FilesystemPathFlavor> {
  // Keyed by pairing: a same-id re-pair may name a machine with another OS.
  const key = `${environmentId}:${getRuntimeEnvironmentRevision(environmentId) ?? ''}`
  let flavor = runtimeServerPathFlavors.get(key)
  if (!flavor) {
    flavor = browseRuntimeServerDirectory(environmentId, '~').then((listing) => listing.pathFlavor)
    // A failed probe must not pin its verdict; the next resume asks again.
    flavor.catch(() => runtimeServerPathFlavors.delete(key))
    runtimeServerPathFlavors.set(key, flavor)
  }
  return flavor
}

function aiVaultCwdPathFlavor(cwd: string): FilesystemPathFlavor {
  return isWindowsAbsolutePathLike(cwd) ? 'win32' : 'posix'
}
