import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
const componentsRoot = path.join(repoRoot, 'src/renderer/src/components')

const updateCapableCallers = new Map<string, readonly string[]>([
  [
    'src/renderer/src/components/settings/OrchestrationPane.tsx',
    ['ORCHESTRATION_SKILL_UPDATE_COMMAND', 'installedCommand={orchestrationUpdateCommand}']
  ],
  [
    'src/renderer/src/components/settings/OrchestrationSetupCard.tsx',
    ['ORCHESTRATION_SKILL_UPDATE_COMMAND', 'installedCommand={updateCommand}']
  ],
  [
    'src/renderer/src/components/floating-terminal/FloatingTerminalOrchestrationDialog.tsx',
    ['ORCHESTRATION_SKILL_UPDATE_COMMAND', 'installedCommand={updateCommand}']
  ],
  [
    'src/renderer/src/components/settings/ComputerUseSkillSetupPanel.tsx',
    ['COMPUTER_USE_SKILL_UPDATE_COMMAND', 'installedCommand={updateCommand}']
  ],
  [
    'src/renderer/src/components/settings/CliAgentSkillSetup.tsx',
    ['ORCA_CLI_SKILL_UPDATE_COMMAND', 'installedCommand={cliSkillUpdateCommand}']
  ],
  [
    'src/renderer/src/components/settings/CliSection.tsx',
    ['ORCA_CLI_SKILL_UPDATE_COMMAND', 'installedCommand={cliSkillUpdateCommand}']
  ],
  [
    'src/renderer/src/components/settings/BrowserUsePane.tsx',
    ['ORCA_CLI_SKILL_UPDATE_COMMAND', 'installedCommand={browserUseUpdateCommand}']
  ],
  [
    'src/renderer/src/components/settings/BrowserUseSkillStep.tsx',
    ['installedCommand={installedCommand}']
  ],
  [
    'src/renderer/src/components/feature-wall/BrowserUseSkillSetupCard.tsx',
    ['ORCA_CLI_SKILL_UPDATE_COMMAND', 'installedCommand={updateCommand}']
  ],
  [
    'src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.tsx',
    ['ORCA_LINEAR_SKILL_UPDATE_COMMAND', 'installedCommand={installedCommand}']
  ],
  [
    'src/renderer/src/components/sidebar/LinearAgentSkillSetupDialog.tsx',
    ['installedCommand={installedCommand}']
  ],
  [
    'src/renderer/src/components/settings/MobileEmulatorAgentControlRow.tsx',
    ['ORCA_CLI_SKILL_UPDATE_COMMAND', 'installedCommand={ORCA_CLI_SKILL_UPDATE_COMMAND}']
  ]
])

const installOnlyCallers = new Map<string, readonly string[]>([
  [
    'src/renderer/src/components/emulator-pane/MobileEmulatorAgentSetupGuideSteps.tsx',
    ['showInstallWhenInstalled={!setup.cliSkillInstalled}']
  ]
])

const directPanelCallers = new Set([
  // BrowserUsePane and LinearAgentSkillSetupPrompt delegate through child setup
  // components that forward installedCommand and are validated separately above.
  ...[...updateCapableCallers.keys()].filter(
    (relativePath) =>
      relativePath !== 'src/renderer/src/components/settings/BrowserUsePane.tsx' &&
      relativePath !== 'src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.tsx'
  ),
  ...installOnlyCallers.keys()
])

function relativeRepoPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function findProductionPanelCallers(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry)
    const stat = statSync(entryPath)
    if (stat.isDirectory()) {
      found.push(...findProductionPanelCallers(entryPath))
      continue
    }
    if (!entryPath.endsWith('.tsx') || entryPath.includes('.test.')) {
      continue
    }
    const source = readFileSync(entryPath, 'utf8')
    if (source.includes('<AgentSkillSetupPanel')) {
      found.push(relativeRepoPath(entryPath))
    }
  }
  return found.sort()
}

describe('AgentSkillSetupPanel installed-command call sites', () => {
  it('keeps every update-capable production caller on an explicit single-skill update command', () => {
    for (const [relativePath, expectedSnippets] of updateCapableCallers) {
      const source = readRepoFile(relativePath)
      for (const snippet of expectedSnippets) {
        expect(source, `${relativePath} should include ${snippet}`).toContain(snippet)
      }
    }
  })

  it('keeps orchestration installed updates on the primary panel only', () => {
    const source = readRepoFile('src/renderer/src/components/settings/OrchestrationPane.tsx')

    expect(source).toContain('installedCommand={orchestrationUpdateCommand}')
    expect(source).not.toContain('Copy update command')
    expect(source).not.toContain('copyUpdateCommand')
  })

  it('fails when a production caller can show the default Update action without installedCommand', () => {
    const productionCallers = findProductionPanelCallers(componentsRoot)

    expect(productionCallers).toEqual([...directPanelCallers].sort())

    for (const [relativePath, expectedSnippets] of installOnlyCallers) {
      const source = readRepoFile(relativePath)
      expect(source, `${relativePath} intentionally hides the installed action`).not.toContain(
        'installedCommand='
      )
      for (const snippet of expectedSnippets) {
        expect(source, `${relativePath} should include ${snippet}`).toContain(snippet)
      }
    }
  })
})
