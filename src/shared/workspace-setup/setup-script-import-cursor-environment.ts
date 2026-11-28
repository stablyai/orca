import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import { normalizeSetupScriptImportCommand } from './setup-script-import-command-limits'
import { collectPresentFields, parseJsoncObject } from './setup-script-import-parsers'

const CURSOR_ENVIRONMENT_PATH = '.cursor/environment.json'
// Boot commands, terminals and image sources describe the cloud machine, not per-workspace setup.
const UNSUPPORTED_FIELDS = ['start', 'terminals', 'build', 'image', 'snapshot'] as const

export async function inspectCursorEnvironmentConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const config = parseJsoncObject(await readFile(CURSOR_ENVIRONMENT_PATH))
  const setup = config ? normalizeSetupScriptImportCommand(config.install) : ''
  if (!config || !setup) {
    return null
  }
  return {
    provider: 'cursor',
    label: 'Cursor',
    files: [CURSOR_ENVIRONMENT_PATH],
    setup,
    unsupportedFields: collectPresentFields(config, UNSUPPORTED_FIELDS)
  }
}
