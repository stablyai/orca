export const SSH_PORTS_SHOW_OTHER_USERS_STORAGE_KEY = 'orca.sshPorts.showOtherUsers.v1'

type PreferenceStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function getRendererStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Default off: only owned ports until the user opts in. */
export function readSshPortsShowOtherUsers(
  storage: PreferenceStorage | null = getRendererStorage()
): boolean {
  if (!storage) {
    return false
  }
  try {
    return storage.getItem(SSH_PORTS_SHOW_OTHER_USERS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeSshPortsShowOtherUsers(
  showOtherUsers: boolean,
  storage: PreferenceStorage | null = getRendererStorage()
): void {
  if (!storage) {
    return
  }
  try {
    storage.setItem(SSH_PORTS_SHOW_OTHER_USERS_STORAGE_KEY, showOtherUsers ? 'true' : 'false')
  } catch {
    // localStorage may be unavailable (private mode / quota)
  }
}
