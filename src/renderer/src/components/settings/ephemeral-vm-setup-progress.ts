// Why: pure, React-free derivation of the Ephemeral VMs setup-plan progress so it
// can be unit-tested. Mirrors settings-setup-guide-progress.ts. Only signals Orca
// can actually verify locally count toward "confirmed" — never self-attestation.

export type EphemeralVmSetupStepId = 'prerequisites' | 'skill' | 'scaffold' | 'validate'

export const EPHEMERAL_VM_SETUP_STEP_IDS: readonly EphemeralVmSetupStepId[] = [
  'prerequisites',
  'skill',
  'scaffold',
  'validate'
] as const

export type EphemeralVmSetupSignals = {
  /** Orca CLI detected on PATH — the only prerequisite Orca owns. */
  orcaCliReady: boolean
  /** Ephemeral VMs skill detected as installed. */
  skillInstalled: boolean
  /** At least one vmRecipes entry discovered across local repos. */
  recipeCount: number
  /** A recipe passed `doctor` (the only "ready" signal Orca trusts). */
  doctorOk: boolean
}

export type EphemeralVmSetupProgress = {
  stepDone: Record<EphemeralVmSetupStepId, boolean>
  firstIncompleteStepId: EphemeralVmSetupStepId | null
  /** Steps Orca has actually verified (drives the "N / total confirmed" pill). */
  doneCount: number
  total: number
}

export function getEphemeralVmSetupProgress(
  signals: EphemeralVmSetupSignals
): EphemeralVmSetupProgress {
  const stepDone: Record<EphemeralVmSetupStepId, boolean> = {
    // Orca can only confirm its own CLI; the rest of the checklist is the user's
    // account and is informational, so the step is "confirmed" once the CLI is ready.
    prerequisites: signals.orcaCliReady,
    skill: signals.skillInstalled,
    // The agent does the scaffold/build/auth; the detectable proxy is a recipe existing.
    scaffold: signals.recipeCount > 0,
    // A green doctor on a real recipe — the only end-to-end "ready" signal.
    validate: signals.doctorOk
  }

  const firstIncompleteStepId = EPHEMERAL_VM_SETUP_STEP_IDS.find((id) => !stepDone[id]) ?? null
  const doneCount = EPHEMERAL_VM_SETUP_STEP_IDS.filter((id) => stepDone[id]).length

  return {
    stepDone,
    firstIncompleteStepId,
    doneCount,
    total: EPHEMERAL_VM_SETUP_STEP_IDS.length
  }
}
