/**
 * Agent browser input must reach its page without touching the user's keyboard focus (#20595).
 * Runs hidden; browser-agent-input-focus-isolation-native.spec.ts repeats it in a visible window.
 */

import { test } from './helpers/orca-app'
import {
  runAgentClicksScenario,
  runAgentCrossSiteFrameScenario,
  runAgentKeysScenario,
  runAgentShortcutsScenario
} from './helpers/browser-agent-focus-scenarios'

test('agent keys and text reach the page without leaving the user’s terminal', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentKeysScenario(orcaPage)
})

test('agent clicks and presses reach the page without leaving the user’s terminal', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentClicksScenario(orcaPage)
})

test('agent shortcut keys stay in the page instead of running Orca shortcuts', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentShortcutsScenario(orcaPage)
})

test('agent keys and text reach a focused cross-site frame without moving the user’s focus', async ({
  orcaPage
}) => {
  test.setTimeout(120_000)
  await runAgentCrossSiteFrameScenario(orcaPage)
})
