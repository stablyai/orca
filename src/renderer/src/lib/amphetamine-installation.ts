export const AMPHETAMINE_APP_STORE_URL = 'https://apps.apple.com/app/amphetamine/id937984704'

export function openAmphetamineListing(): Promise<void> {
  return window.api.shell.openUrl(AMPHETAMINE_APP_STORE_URL)
}

export function refreshAmphetamineInstallation(): Promise<boolean | undefined> {
  return window.api.agentAwake.probeAmphetamine()
}
