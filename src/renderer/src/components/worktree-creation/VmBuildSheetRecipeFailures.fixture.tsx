import { defineFixture } from '../../component-fixtures/component-fixture'
import { entry, FAILED_LOG, frame, LOG, T0 } from './vm-build-sheet-fixture-support'

// Local custom-recipe failures: a plain summary, with the raw error behind Details.

function openDetails(root: HTMLElement): void {
  const toggle = Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Details'
  )
  toggle?.click()
}

function expanded(fixture: ReturnType<typeof frame>) {
  return defineFixture({ ...fixture, interact: openDetails })
}

const failedEntry = entry({ status: 'error', provisioningLog: FAILED_LOG, errorAt: T0 + 98_000 })

/** Collapsed: only the summary and the Details toggle. */
export const recipeDetailsCollapsed = frame(failedEntry, 'Recipe exited with code 1.')

/** Expanded: the exit message plus the log's first error line, with Copy. */
export const recipeDetailsExpanded = expanded(frame(failedEntry, 'Recipe exited with code 1.'))

const LONG_ERROR = [
  'Recipe exited with code 1.',
  'npm ERR! code ERESOLVE',
  'npm ERR! ERESOLVE unable to resolve dependency tree',
  'npm ERR!',
  'npm ERR! While resolving: web@0.1.0',
  'npm ERR! Found: react@19.0.0',
  'npm ERR! node_modules/react',
  'npm ERR!   react@"^19.0.0" from the root project',
  'npm ERR!',
  'npm ERR! Could not resolve dependency:',
  'npm ERR! peer react@"^18.2.0" from react-beautiful-dnd@13.1.1',
  'npm ERR! node_modules/react-beautiful-dnd',
  'npm ERR!   react-beautiful-dnd@"^13.1.1" from the root project',
  'npm ERR!',
  'npm ERR! Fix the upstream dependency conflict, or retry',
  'npm ERR! this command with --force or --legacy-peer-deps',
  'npm ERR! to accept an incorrect (and potentially broken) dependency resolution.',
  'npm ERR!',
  'npm ERR! A complete log of this run can be found in:',
  'npm ERR!     /root/.npm/_logs/2026-11-10T12_00_00_000Z-debug-0.log',
  'error: setup step "npm ci" failed',
  '    at runStep (/opt/orca/recipe-runner.js:142:11)',
  '    at async runRecipe (/opt/orca/recipe-runner.js:88:5)',
  '    at async main (/opt/orca/recipe-runner.js:21:3)',
  'Recipe aborted after 3 of 5 steps.'
].join('\n')

/** Truncated: more than 20 lines, so only the last 20 show, under a note on the earlier ones. */
export const recipeDetailsTruncated = expanded(
  frame(entry({ status: 'error', provisioningLog: LOG, errorAt: T0 + 98_000 }), LONG_ERROR)
)
