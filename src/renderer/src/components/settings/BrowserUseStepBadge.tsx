// Why: StepBadge moved to the feature-neutral SetupStepBadge so other setup panes
// (e.g. Ephemeral VMs) can reuse it without importing a browser-use-named file.
// This re-export keeps existing browser-use imports working.
export { StepBadge, type StepState } from './SetupStepBadge'
