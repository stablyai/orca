import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  type HookContractFact,
  readFlattenedHookFacts,
  readHookDefinitions
} from './refactor-hook-contract.test-support'

const TASK_PAGE_SOURCE_PATTERN = /^(?:TaskPage.*\.tsx|use-task-page-.*\.ts|task-page-.*\.tsx?)$/
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

export const TASK_PAGE_SOURCE_FILES = readdirSync(__dirname)
  .filter(
    (name) =>
      TASK_PAGE_SOURCE_PATTERN.test(name) &&
      !name.includes('.test.') &&
      !name.includes('.test-support.')
  )
  .sort()

export const TASK_PAGE_REFACTOR_SOURCE_FILES = TASK_PAGE_SOURCE_FILES.filter(
  (name) =>
    /^TaskPage.*\.tsx$/.test(name) ||
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
