import { z } from 'zod'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  SSH_REMOTE_RUNTIMES
} from '../../remote-runtime/ssh/ssh-types'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const SshTarget = z.object({
  targetId: z.string().min(1)
})

// Why `automatic`: a client's background connect must not lift the host's cancelled sign-in.
export const SshConnect = SshTarget.extend({
  automatic: z.boolean().optional()
})

export const SshSubmitCredential = z.object({
  requestId: z.string().trim().min(1).max(200),
  // Do not trim: keyboard-interactive answers and passphrases may contain whitespace.
  value: z.string().max(65_536).nullable()
})

const boundedText = (max: number) => z.string().trim().min(1).max(max)

// Reject unknown keys, including credentials and host-owned fences, so callers cannot believe secrets were saved.
// Ask for credentials when connecting.
export const SshEditableTargetInput = z
  .object({
    label: boundedText(200),
    configHost: boundedText(512).optional(),
    host: boundedText(512),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().max(200),
    identityFile: boundedText(4096).optional(),
    identityAgent: boundedText(4096).optional(),
    identitiesOnly: z.boolean().optional(),
    gssapiAuthentication: z.boolean().optional(),
    proxyCommand: boundedText(4096).optional(),
    jumpHost: boundedText(1024).optional(),
    relayGracePeriodSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
      .refine(
        (value) => value === 0 || value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        `Terminal timeout must be 0 or at least ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS} seconds`
      )
      .optional(),
    systemSshConnectionReuse: z.boolean().optional(),
    systemSshProxyConnectionReuse: z.boolean().optional(),
    remoteRuntime: z.enum(SSH_REMOTE_RUNTIMES).optional(),
    allowRemoteCliControl: z.boolean().optional()
  })
  .strict()

export const SshTargetAdd = z.object({ target: SshEditableTargetInput })

/** Replaces the target's editable fields; an omitted optional field is cleared. */
export const SshTargetUpdate = SshTarget.extend({ target: SshEditableTargetInput })

// Why untrimmed: a remote folder name may legitimately end in a space.
export const SshBrowseDir = SshTarget.extend({
  dirPath: z.string().min(1).max(4096)
})

export const SshFileReadChunk = SshTarget.extend({
  filePath: z.string().min(1).max(4096),
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(512 * 1024),
  expectedGeneration: z.number().int().positive().optional()
})

export const SshFolderDownload = SshTarget.extend({
  dirPath: z.string().min(1).max(4096),
  destinationPath: z.string().min(1).max(32_768),
  expectedGeneration: z.number().int().positive().optional()
})

export const SshImportConfig = z.object({
  reAdopt: z.boolean().optional()
})

export const SshConfigHostList = z.object({
  query: z.string().max(4096).optional(),
  refresh: z.boolean().optional()
})

export const SshResolveConfigHost = z.object({
  alias: z.string().trim().min(1).max(512)
})

export const SshResolveExternalEditorAuthority = z.object({
  targetId: z.string().min(1)
})

const portNumber = z.number().int().min(1).max(65_535)
export const SshPortForwardAdd = SshTarget.extend({
  localPort: portNumber,
  remoteHost: boundedText(4096),
  remotePort: portNumber,
  label: z.string().trim().max(200).optional()
})
export const SshPortForwardUpdate = z.object({
  id: boundedText(200),
  targetId: boundedText(200),
  localPort: portNumber,
  remoteHost: boundedText(4096),
  remotePort: portNumber,
  label: z.string().trim().max(200).optional()
})
export const SshPortForwardRemove = z.object({ id: boundedText(200) })
export const SshPortForwardList = z.object({ targetId: boundedText(200).optional() })

// Why these bounds: relay-era app PTY ids (`ssh:<target>@@<relay id>`) stay well under
// 4k, matching the Electron IPC schema for the same channels.
export const SshLegacyRelayPane = z.object({
  ptyId: boundedText(4096)
})
export const SshLegacyRelayPaneDetach = SshLegacyRelayPane.extend({
  // Why optional: clients older than viewer-scoped detach omit it; those viewers cannot be released safely.
  acquisitionId: z.number().int().optional()
})
export const SshLegacyRelayPaneWrite = SshLegacyRelayPane.extend({
  // Do not trim: terminal input may legitimately be whitespace.
  data: z.string().max(1_048_576)
})
export const SshLegacyRelayPaneResize = SshLegacyRelayPane.extend({
  cols: z.number().int().positive().max(10_000),
  rows: z.number().int().positive().max(10_000)
})
export const SshLegacyRelayPaneOutputPaused = SshLegacyRelayPane.extend({
  paused: z.boolean()
})

export const RepoAddRemote = z.object({
  connectionId: requiredString('Missing SSH target'),
  remotePath: requiredString('Missing remote path'),
  displayName: OptionalString,
  kind: z.enum(['git', 'folder']).optional()
})
