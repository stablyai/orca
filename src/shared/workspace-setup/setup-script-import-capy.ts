import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import { normalizeSetupScriptImportCommand } from './setup-script-import-command-limits'
import { asRecord, collectPresentFields, parseJsonObject } from './setup-script-import-parsers'

const CAPY_SETUP_PATH = '.capy/setup.json'

export async function inspectCapySetupConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const config = parseJsonObject(await readFile(CAPY_SETUP_PATH))
  const scripts = asRecord(config?.scripts)
  // initialize runs once per fresh clone, which is what an Orca setup script is.
  const setup = scripts ? normalizeSetupScriptImportCommand(scripts.initialize) : ''
  if (!config || !scripts || !setup) {
    return null
  }
  return {
    provider: 'capy',
    label: 'Capy',
    files: [CAPY_SETUP_PATH],
    setup,
    unsupportedFields: [
      ...collectPresentFields(scripts, ['refresh'], 'scripts.'),
      ...collectPresentFields(config, ['startup', 'commands'])
    ]
  }
}
