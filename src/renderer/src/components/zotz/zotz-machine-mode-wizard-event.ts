const ZOTZ_MACHINE_MODE_WIZARD_OPEN_EVENT = 'zotz:machine-mode-wizard-open'

export function openZotzMachineModeWizard(): void {
  window.dispatchEvent(new Event(ZOTZ_MACHINE_MODE_WIZARD_OPEN_EVENT))
}

export function onZotzMachineModeWizardOpen(callback: () => void): () => void {
  window.addEventListener(ZOTZ_MACHINE_MODE_WIZARD_OPEN_EVENT, callback)
  return () => window.removeEventListener(ZOTZ_MACHINE_MODE_WIZARD_OPEN_EVENT, callback)
}

/** Remote web clients render another host's settings; only the local desktop owns its machine mode. */
export function isZotzMachineModeHost(): boolean {
  return !('__ORCA_WEB_CLIENT__' in window && window.__ORCA_WEB_CLIENT__ === true)
}

/** E2E drivers run upstream suites; web clients have no zotzNode bridge. */
export function isZotzAutomatedLaunch(): boolean {
  return window.api?.zotzNode?.automatedLaunch === true
}
