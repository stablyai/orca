import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type HookContractFact,
  readFlattenedHookFacts,
  readHookDefinitions
} from './refactor-hook-contract.test-support'

const TASK_PAGE_FLAT_SOURCE_PATTERN = /^(?:use-task-page-.*\.ts|task-page-.*\.tsx?)$/
const TASK_PAGE_DIRECTORY = 'task-page'
const TASK_PAGE_EXTRACTED_LOWERCASE_FILES = new Set([
  'task-page-draft-storage.tsx',
  'task-page-github-landing-refresh-run.tsx',
  'task-page-github-quiet-refresh-run.tsx',
  'task-page-github-review-model.tsx',
  'task-page-github-reviewer-actions.ts',
  'task-page-linear-issue-model.tsx',
  'task-page-linear-jira-list-model.tsx',
  'task-page-source-context.tsx'
])

function isSourceFile(name: string): boolean {
  return !name.includes('.test.') && !name.includes('.test-support.')
}

// Why: the components/task-page tree nests by provider, so a flat readdir would silently
// return an empty family and turn every ratchet built on it into a no-op.
function readTaskPageDirectory(relativeDirectory: string): string[] {
  return readdirSync(join(__dirname, relativeDirectory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        return readTaskPageDirectory(relativePath)
      }
      return /\.tsx?$/.test(entry.name) && isSourceFile(entry.name) ? [relativePath] : []
    }
  )
}

export const TASK_PAGE_SOURCE_FILES = [
  ...readdirSync(__dirname).filter(
    (name) => TASK_PAGE_FLAT_SOURCE_PATTERN.test(name) && isSourceFile(name)
  ),
  ...readTaskPageDirectory(TASK_PAGE_DIRECTORY)
].sort()

export const TASK_PAGE_REFACTOR_SOURCE_FILES = TASK_PAGE_SOURCE_FILES.filter(
  (name) =>
    (name.startsWith(`${TASK_PAGE_DIRECTORY}/`) && name.endsWith('.tsx')) ||
    /^use-task-page-.*\.ts$/.test(name) ||
    TASK_PAGE_EXTRACTED_LOWERCASE_FILES.has(name)
)

export function readTaskPageSource(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

export function readTaskPageSourceFamily(): string {
  return TASK_PAGE_SOURCE_FILES.map(
    (relativePath) => `// TaskPage source: ${relativePath}\n${readTaskPageSource(relativePath)}`
  ).join('\n')
}

export function readTaskPageRefactorSourceFamily(): string {
  return TASK_PAGE_REFACTOR_SOURCE_FILES.map(readTaskPageSource).join('\n')
}

export function readFlattenedTaskPageHookFacts(): HookContractFact[] {
  const definitions = readHookDefinitions(
    TASK_PAGE_REFACTOR_SOURCE_FILES.map((relativePath) => ({
      relativePath,
      source: readTaskPageSource(relativePath)
    })),
    (name) => name === 'TaskPage' || name.startsWith('useTaskPage')
  )
  return readFlattenedHookFacts(definitions, 'TaskPage')
}

export function readFlattenedTaskPageHookOrder(): string[] {
  return readFlattenedTaskPageHookFacts().map(({ name }) => name)
}
