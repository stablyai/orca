import { defineConfig } from '@playwright/test'

// Local discrimination-run config only: these specs drive real daemon processes
// directly and need no Electron app build, so globalSetup is deliberately absent.
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  projects: [{ name: 'daemon-node', testMatch: '**/daemon-restart-session-liveness.spec.ts' }]
})
