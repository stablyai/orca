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
  return !(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
}
