const RUNNABLE_FILE_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.bash',
  '.cjs',
  '.cmd',
  '.com',
  '.exe',
  '.fish',
  '.jar',
  '.js',
  '.jsx',
  '.lua',
  '.mjs',
  '.msi',
  '.php',
  '.pl',
  '.ps1',
  '.py',
  '.pyw',
  '.rb',
  '.sh',
  '.ts',
  '.tsx',
  '.wasm',
  '.zsh'
])

const RUNNABLE_PATH_PREFIXES = ['bin/', 'hooks/', 'scripts/']

export type SkillInstallRiskFile = {
  path: string
  executable: boolean
  classification: 'text' | 'binary'
}

export type SkillInstallRiskItem = {
  id: string
  name: string
  files: readonly SkillInstallRiskFile[]
}

export type SkillInstallRiskSummary = {
  selectedSkillCount: number
  additionalFileCount: number
  runnableFileCount: number
  binaryFileCount: number
  cautionFileCount: number
  cautionSkillNames: string[]
  requiresAcknowledgement: boolean
}

export function isSkillInstructionFile(file: SkillInstallRiskFile): boolean {
  return file.path.toLocaleLowerCase('en-US') === 'skill.md'
}

export function isSkillBinaryFile(file: SkillInstallRiskFile): boolean {
  return file.classification === 'binary'
}

export function isSkillRunnableFile(file: SkillInstallRiskFile): boolean {
  if (file.executable) {
    return true
  }
  const normalizedPath = file.path.toLocaleLowerCase('en-US')
  if (RUNNABLE_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
    return true
  }
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
  const extensionIndex = fileName.lastIndexOf('.')
  return extensionIndex !== -1 && RUNNABLE_FILE_EXTENSIONS.has(fileName.slice(extensionIndex))
}

export function summarizeSkillInstallRisk(
  items: readonly SkillInstallRiskItem[],
  selectedIds: ReadonlySet<string> | null
): SkillInstallRiskSummary {
  const selectedItems = selectedIds ? items.filter((item) => selectedIds.has(item.id)) : items
  let additionalFileCount = 0
  let runnableFileCount = 0
  let binaryFileCount = 0
  let cautionFileCount = 0
  const cautionSkillNames: string[] = []

  for (const item of selectedItems) {
    let itemNeedsCaution = false
    for (const file of item.files) {
      if (!isSkillInstructionFile(file)) {
        additionalFileCount += 1
      }
      const runnable = isSkillRunnableFile(file)
      const binary = isSkillBinaryFile(file)
      runnableFileCount += runnable ? 1 : 0
      binaryFileCount += binary ? 1 : 0
      if (runnable || binary) {
        cautionFileCount += 1
        itemNeedsCaution = true
      }
    }
    if (itemNeedsCaution) {
      cautionSkillNames.push(item.name)
    }
  }

  return {
    selectedSkillCount: selectedItems.length,
    additionalFileCount,
    runnableFileCount,
    binaryFileCount,
    cautionFileCount,
    cautionSkillNames,
    requiresAcknowledgement: cautionFileCount > 0
  }
}
