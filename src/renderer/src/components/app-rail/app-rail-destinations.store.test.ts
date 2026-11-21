import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { activateRailDestination } from './app-rail-destinations'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

it("leaves Settings first, so the destination's own Close returns to the page before Settings", async () => {
  useAppStore.setState({ activeView: 'terminal' })
  useAppStore.getState().openSettingsPage()

  activateRailDestination('tasks')
  await Promise.resolve()

  expect(useAppStore.getState().activeView).toBe('tasks')
  useAppStore.getState().closeTaskPage()
  expect(useAppStore.getState().activeView).toBe('terminal')
})

it('returns to an open Tasks page under Settings without resetting it', async () => {
  useAppStore.getState().openTaskPage({ taskSource: 'linear' })
  useAppStore.getState().openSettingsPage()

  activateRailDestination('tasks')
  await Promise.resolve()

  expect(useAppStore.getState().activeView).toBe('tasks')
  expect(useAppStore.getState().taskPageData).toEqual({ taskSource: 'linear' })
})

it('opens Automations over Tasks from Settings with Tasks as its predecessor', async () => {
  useAppStore.getState().openTaskPage()
  useAppStore.getState().openSettingsPage()

  activateRailDestination('automations')
  await Promise.resolve()

  expect(useAppStore.getState().activeView).toBe('automations')
  useAppStore.getState().closeAutomationsPage()
  expect(useAppStore.getState().activeView).toBe('tasks')
})

it.each([
  ['artifacts', () => useAppStore.getState().closeArtifactsPage()],
  ['skills', () => useAppStore.getState().closeSkillsPage()],
  ['mobile', () => useAppStore.getState().closeMobilePage()]
] as const)(
  "leaves Settings first for %s, so the page's own Close returns to the page before Settings",
  async (id, closePage) => {
    useAppStore.setState({ activeView: 'terminal' })
    useAppStore.getState().openSettingsPage()

    activateRailDestination(id)
    await Promise.resolve()

    expect(useAppStore.getState().activeView).toBe(id)
    closePage()
    expect(useAppStore.getState().activeView).toBe('terminal')
  }
)
