// SSH access to Orca Cloud workspaces: contract shared by main, the renderer and the CLI.

/** Desktop RPC the CLI's `orca ssh-proxy` calls: wakes the workspace and opens the SSH forward. */
export const CLOUD_SSH_TUNNEL_METHOD = 'cloudSsh.tunnel'
/** Desktop RPC `orca ssh` calls: ensures access and answers how to run ssh. */
export const CLOUD_SSH_PREPARE_METHOD = 'cloudSsh.prepare'

/** sshd inside every Orca Cloud VM (image/vm/orca-sshd); reachable only through the forward. */
export const CLOUD_SSH_REMOTE_PORT = 2222

export type CloudSshErrorCode =
  | 'not_found'
  | 'not_cloud'
  | 'not_configured'
  | 'asleep'
  | 'wake_failed'
  | 'unsupported_image'
  | 'forward_failed'
  | 'control_plane'
  | 'cli_missing'
  | 'editor_missing'

export type CloudSshFailure = { ok: false; code: CloudSshErrorCode; message: string }

export type CloudSshEditorKind = 'vscode' | 'cursor'

export type CloudSshEditor = {
  /** Open In application id from settings. */
  id: string
  label: string
  kind: CloudSshEditorKind
}

export type CloudSshStatus = {
  /** An Orca Cloud workspace: the SSH actions apply. */
  cloud: boolean
  /** This device holds a key for it. */
  hasAccess: boolean
  /** The VM sleeps: the next SSH action wakes it first. */
  asleep: boolean
  alias: string | null
  /** ~/.ssh/config includes Orca's config, so editors resolve the alias. */
  includeInstalled: boolean
  /** Installed editors whose Remote-SSH can open the workspace. */
  editors: CloudSshEditor[]
}

export type CloudSshPrepareResult =
  | { ok: true; alias: string; configFile: string; command: string; projectRoot: string }
  | CloudSshFailure

/** "Copy SSH Command": `command` went to the clipboard; `displayCommand` abbreviates the home dir. */
export type CloudSshCopyResult =
  | { ok: true; command: string; displayCommand: string }
  | CloudSshFailure

export type CloudSshTunnelResult = { ok: true; host: '127.0.0.1'; port: number } | CloudSshFailure

export type CloudSshOpenEditorRequest = {
  workspaceId: string
  editorId: string
  /** Set once the user agreed to the one-line Include in ~/.ssh/config. */
  allowSshConfigInclude: boolean
}

export type CloudSshOpenEditorResult =
  | { ok: true }
  /** The exact line Orca would add to ~/.ssh/config, shown to the user before it does. */
  | { ok: false; code: 'include_required'; includeLine: string }
  | CloudSshFailure

export type CloudSshRevokeResult = { ok: true; removedFromWorkspace: boolean } | CloudSshFailure
