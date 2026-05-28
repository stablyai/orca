export const SETUP_SCRIPT_IMPORT_PROVIDERS = ['superset', 'conductor', 'codex', 'cmux'] as const

export type SetupScriptImportProvider = (typeof SETUP_SCRIPT_IMPORT_PROVIDERS)[number]
