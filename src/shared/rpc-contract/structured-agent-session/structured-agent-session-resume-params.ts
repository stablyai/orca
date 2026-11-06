import * as z from 'zod'
import { Identifier, SessionId } from './structured-agent-session-identifiers'

/** The renderer drops recorded args past this bound rather than failing the whole create. */
export const RESUME_SOURCE_AGENT_ARGS_MAX_CHARS = 8 * 1024

/** Identity only: derive transcript/account paths host-side so clients cannot choose imported files or credential directories. */
export const ResumeSource = z
  .object({
    providerSessionId: Identifier('Invalid provider session id'),
    cliSource: z
      .object({
        workspaceId: Identifier('Invalid workspace id'),
        paneKey: Identifier('Invalid pane key')
      })
      .strict()
      .optional(),
    /** Requires agent-session.structured.source-terminal-args.v1 on the executing host. */
    agentArgs: z.string().max(RESUME_SOURCE_AGENT_ARGS_MAX_CHARS).optional()
  })
  .strict()

/** Native-history fork: the host resolves the provider cut from the source chat's own transcript. */
export const ForkSource = z
  .object({ sessionId: SessionId, throughItemId: Identifier('Invalid fork item id') })
  .strict()

/** A chat starts fresh, resumes a provider conversation, or forks a native chat. */
export const SOURCE_FIELDS = {
  resumeFrom: ResumeSource.optional(),
  forkFrom: ForkSource.optional()
}

/** createSupport's resume question, sent only to hosts advertising
 *  agent-session.structured.resume-writer-admission.v1: does another terminal run the conversation,
 *  apart from the panes the client closes before create? */
export const ResumeWriterAdmission = z
  .object({
    providerSessionId: Identifier('Invalid provider session id'),
    closingPaneKeys: z.array(Identifier('Invalid pane key')).max(256).optional()
  })
  .strict()
