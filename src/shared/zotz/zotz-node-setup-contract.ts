/** Passed by the OS supervisor (logon task, LaunchAgent, systemd unit) so a duplicate launch stays silent. */
export const ZOTZ_NODE_AUTOSTART_ARG = '--zotz-node-autostart'

export const ZOTZ_TAILNET_RANGE = '100.64.0.0/10'

export const ZOTZ_AUTOLOGON_URL = 'https://learn.microsoft.com/sysinternals/downloads/autologon'

export type ZotzNodeSetupStepId =
  | 'tailscale'
  | 'power'
  | 'windowsUpdate'
  | 'ssh'
  | 'firewall'
  | 'autostart'
  | 'keepAwake'
  | 'networkExposure'
  | 'autologon'

export type ZotzNodeSetupStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export type ZotzNodeSetupStep = {
  id: ZotzNodeSetupStepId
  status: ZotzNodeSetupStepStatus
  /** Machine-produced detail (command output, reason); the renderer owns the translated label. */
  detail?: string
  /** A page the user can open to finish the step by hand (Tailscale login, Autologon). */
  url?: string
}

/** Live state sent while setup runs; `output` is the shell-style log the user can read. */
export type ZotzNodeSetupProgress = {
  steps: ZotzNodeSetupStep[]
  output: string[]
}

export type ZotzNodeSetupResult = {
  steps: ZotzNodeSetupStep[]
  tailscaleIp: string | null
}

export type ZotzTailscaleStatus = {
  installed: boolean
  /** Logged in and connected; only then is `ip` set. */
  running: boolean
  ip: string | null
  authUrl: string | null
}

export type ZotzAutostartRemovalResult = { ok: boolean; removed: boolean; detail: string }
