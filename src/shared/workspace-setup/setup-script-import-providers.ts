export const SETUP_SCRIPT_IMPORT_PROVIDERS = [
  'superset',
  'conductor',
  'codex',
  'cmux',
  'cursor',
  'copilot',
  'capy',
  'devcontainer',
  'package-manager'
] as const

export type SetupScriptImportProvider = (typeof SETUP_SCRIPT_IMPORT_PROVIDERS)[number]
