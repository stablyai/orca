// One English table for WSL host refusals and status details: main builds the English wire text, the renderer translates by code.
export const WSL_HOST_ADD_REFUSAL_COPY = {
  turnedOff: 'WSL hosts are turned off in Settings → Experimental.',
  newWorkPaused:
    'Adding WSL hosts and moving projects onto them is paused in this build. Your saved WSL hosts keep working.',
  serverFilesMissing: 'This build of Orca can’t run WSL hosts (server files missing).',
  alreadyAdded: '{{distro}} is already a host.',
  distroStopped: '{{distro}} stopped since the list was read. Choose Start and add to start it.',
  wsl1: '{{distro}} runs WSL 1, which Orca no longer supports. Convert it to WSL 2 in a Windows terminal with: {{command}}',
  notRegistered:
    '{{distro}} is not an installed WSL distro. Run {{command}} in a Windows terminal to see the installed ones, or reinstall it and try again.',
  sshManaged:
    '{{distro}} already runs the Orca server for “{{server}}”, which this computer reaches over SSH. Remove that server first; moving it to a WSL host isn’t supported yet.'
} as const

export type WslHostAddRefusalCode = keyof typeof WSL_HOST_ADD_REFUSAL_COPY

export const WSL_HOST_STATUS_DETAIL_COPY = {
  runningListUnavailable: 'Windows didn’t report whether the distro is running.',
  guestUnanswered: 'The distro is running but didn’t answer Orca’s check.',
  orcadUnanswered: 'Orca’s server in the distro didn’t answer.',
  restartGaveUp: {
    one: 'Could not restart the Orca server in {{distro}} after {{count}} attempt',
    other: 'Could not restart the Orca server in {{distro}} after {{count}} attempts'
  },
  serviceUnconfirmed: 'The WSL service did not confirm whether the distro runs.',
  peerCheckFailed:
    'Orca couldn’t ask the WSL host whether another Orca on this computer still uses it: {{detail}}',
  removalUnrecorded: 'Orca couldn’t record what this Remove left running: {{detail}}'
} as const

export type WslHostStatusDetailCode = keyof typeof WSL_HOST_STATUS_DETAIL_COPY

export type WslHostCopyParams = Record<string, string | number>

/** A coded English sentence: `text` for older readers, `code`/`params` for translation. */
export type WslHostCodedText = { text: string; code: string; params?: WslHostCopyParams }

export const WSL_LIST_DISTROS_COMMAND = 'wsl --list --verbose'

export function wslSetVersion2Command(distro: string): string {
  return `wsl --set-version ${distro} 2`
}

// One pass, so a distro name containing "{{detail}}" stays verbatim.
function fillWslHostCopy(template: string, values: WslHostCopyParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (slot, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : slot
  )
}

/** Commands stay out of translation; they derive from the distro on both sides. */
export function wslHostAddRefusalValues(
  code: WslHostAddRefusalCode,
  params: WslHostCopyParams
): WslHostCopyParams {
  if (code === 'wsl1' && typeof params.distro === 'string') {
    return { ...params, command: wslSetVersion2Command(params.distro) }
  }
  return code === 'notRegistered' ? { ...params, command: WSL_LIST_DISTROS_COMMAND } : params
}

export function wslHostAddRefusalText(
  code: WslHostAddRefusalCode,
  params: WslHostCopyParams = {}
): WslHostCodedText {
  const text = fillWslHostCopy(
    WSL_HOST_ADD_REFUSAL_COPY[code],
    wslHostAddRefusalValues(code, params)
  )
  return { text, code, ...(Object.keys(params).length > 0 ? { params } : {}) }
}

export function wslHostStatusDetailText(
  code: WslHostStatusDetailCode,
  params: WslHostCopyParams = {}
): WslHostCodedText {
  const entry = WSL_HOST_STATUS_DETAIL_COPY[code]
  const template = typeof entry === 'string' ? entry : params.count === 1 ? entry.one : entry.other
  const text = fillWslHostCopy(template, params)
  return { text, code, ...(Object.keys(params).length > 0 ? { params } : {}) }
}

/** A coded Remove stop reason: English `reason` for older readers, code and params to translate it. */
export function wslHostServerStopReason(
  code: WslHostStatusDetailCode,
  params?: WslHostCopyParams
): { reason: string; reasonCode: string; reasonParams?: WslHostCopyParams } {
  const { text, params: reasonParams } = wslHostStatusDetailText(code, params)
  return { reason: text, reasonCode: code, ...(reasonParams ? { reasonParams } : {}) }
}
