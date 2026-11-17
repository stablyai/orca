import type { SetupScriptImportCandidate, SetupScriptImportFileRead } from './setup-script-imports'
import { dnfLinesIn, referencedScriptPaths, translateDnfInstalls } from './setup-script-dnf'

/**
 * Conductor's cloud runs Amazon Linux, Orca's sandboxes Ubuntu. The setup's own dnf/yum
 * install lines become apt-get where every package maps clearly; a script file it runs is only read
 * (never changed or run) to list the lines that still use dnf.
 */
export async function withUbuntuSetup(
  candidate: SetupScriptImportCandidate | null,
  readFile: SetupScriptImportFileRead
): Promise<SetupScriptImportCandidate | null> {
  if (!candidate) {
    return null
  }
  const { setup, translated, unresolved } = translateDnfInstalls(candidate.setup)
  const fileLines: string[] = []
  for (const path of referencedScriptPaths(candidate.setup)) {
    const content = await readFile(path)
    if (content) {
      fileLines.push(...dnfLinesIn(content).map((line) => `${path}: ${line}`))
    }
  }
  const checkLines = [...unresolved, ...fileLines]
  if (translated === 0 && checkLines.length === 0) {
    return candidate
  }
  return { ...candidate, setup, ubuntuNote: { translated, checkLines } }
}
