import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import {
  isSetupScriptImportFieldWithinLimit,
  SETUP_SCRIPT_IMPORT_MAX_TOML_LINES
} from './setup-script-import-limits'
import { asRecord, collectPresentFields, parseTomlObject } from './setup-script-import-parsers'

const CODEX_ENVIRONMENT_PATH = '.codex/environments/environment.toml'

export async function inspectCodexEnvironmentConfig(
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  const content = await readFile(CODEX_ENVIRONMENT_PATH)
  if (!content || countTomlLines(content) > SETUP_SCRIPT_IMPORT_MAX_TOML_LINES) {
    return null
  }

  const config = parseTomlObject(content)
  if (!config) {
    return null
  }
  const setup = normalizeCodexScript(asRecord(config.setup)?.script)
  if (!setup) {
    return null
  }

  return {
    provider: 'codex',
    label: 'Codex environment',
    files: [CODEX_ENVIRONMENT_PATH],
    setup,
    archive: normalizeCodexScript(asRecord(config.cleanup)?.script) || undefined,
    unsupportedFields: collectPresentFields(config, ['actions'])
  }
}

function normalizeCodexScript(value: unknown): string {
  if (typeof value !== 'string' || !isSetupScriptImportFieldWithinLimit(value)) {
    return ''
  }
  return value.trim()
}

function countTomlLines(content: string): number {
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10 && ++lines > SETUP_SCRIPT_IMPORT_MAX_TOML_LINES) {
      return lines
    }
  }
  return lines
}
