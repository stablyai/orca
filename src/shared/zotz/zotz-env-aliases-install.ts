import { applyZotzEnvAliases } from './zotz-env-aliases'

// Imported first by each entry point so module-level ORCA_* reads already see the aliases.
applyZotzEnvAliases()
