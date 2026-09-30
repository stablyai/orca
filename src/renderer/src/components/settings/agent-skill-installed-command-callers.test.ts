import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
const componentsRoot = path.join(repoRoot, 'src/renderer/src/components')

const updateCapableCallers: readonly string[] = [
  'src/renderer/src/components/settings/OrchestrationPane.tsx',
  'src/renderer/src/components/settings/OrchestrationSetupCard.tsx',
  'src/renderer/src/components/floating-terminal/FloatingTerminalOrchestrationDialog.tsx',
  'src/renderer/src/components/settings/ComputerUseSkillSetupPanel.tsx',
  'src/renderer/src/components/settings/use-linear-agent-skill-setup.ts',
  'src/renderer/src/components/settings/LinearAgentSkillPane.tsx',
  'src/renderer/src/components/settings/TaskSourceLinearSetup.tsx',
  'src/renderer/src/components/settings/EphemeralVmsPane.tsx',
  'src/renderer/src/components/settings/CliSection.tsx',
  'src/renderer/src/components/settings/BrowserUsePane.tsx',
  'src/renderer/src/components/settings/BrowserUseSkillStep.tsx',
  'src/renderer/src/components/feature-wall/BrowserUseSkillSetupCard.tsx',
  'src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.tsx',
  'src/renderer/src/components/sidebar/LinearAgentSkillSetupDialog.tsx',
  'src/renderer/src/components/settings/MobileEmulatorAgentControlRow.tsx'
]

const installOnlyCallers: readonly string[] = [
  'src/renderer/src/components/emulator-pane/MobileEmulatorAgentSetupGuideSteps.tsx'
]

const directPanelCallers = new Set([
  // BrowserUsePane and LinearAgentSkillSetupPrompt render the panel through child
  // components; use-linear-agent-skill-setup is a resolver, not a panel host.
  ...updateCapableCallers.filter(
    (relativePath) =>
      relativePath !== 'src/renderer/src/components/settings/BrowserUsePane.tsx' &&
      relativePath !== 'src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.tsx' &&
      relativePath !== 'src/renderer/src/components/settings/use-linear-agent-skill-setup.ts'
  ),
  ...installOnlyCallers
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
  it('fails when a production caller can show the default Update action without installedCommand', () => {
    const productionCallers = findProductionPanelCallers(componentsRoot)

    expect(productionCallers).toEqual([...directPanelCallers].sort())

    for (const relativePath of installOnlyCallers) {
      expect(
        readRepoFile(relativePath),
        `${relativePath} intentionally hides the installed action`
      ).not.toContain('installedCommand=')
    }
  })
})
