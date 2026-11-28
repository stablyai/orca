import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import type { BotImportSource } from '../../../../shared/bots/bot-import'
import { PortalContainerContext } from '../ui/portal-container-context'
import { ImportBotDialog } from './ImportBotDialog'
import { LONG_FIXTURE_COMPUTER, seedNewBotFixture } from './new-bot-stage-fixture'

const hermes = (agent: string, name: string): BotImportSource['bots'][number] => ({
  agent,
  name,
  path: `~/.hermes/profiles/${agent}`,
  absolutePath: `/home/me/.hermes/profiles/${agent}`
})

const ONE: BotImportSource[] = [
  { app: 'hermes', home: '~/.hermes', bots: [hermes('default', 'Hermes')] }
]
const SEVERAL: BotImportSource[] = [
  { app: 'hermes', home: '~/.hermes', bots: [hermes('default', 'Hermes'), hermes('work', 'Work')] },
  {
    app: 'openclaw',
    home: '~/.openclaw',
    bots: [{ agent: 'main', name: 'main', path: '~/.openclaw', absolutePath: '/home/me/.openclaw' }]
  }
]
const LONG: BotImportSource[] = [
  {
    app: 'hermes',
    home: '~/.hermes',
    bots: [hermes('default', 'Release-Coordinator-For-The-Platform-Team')]
  }
]

const imported: Bot = {
  id: 'bot-hermes',
  name: 'Hermes',
  hostId: 'local',
  folder: 'hermes',
  folderWorkspaceId: 'fw-hermes',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const AGAIN: BotImportSource[] = [
  {
    app: 'hermes',
    home: '~/.hermes',
    bots: [
      { ...hermes('default', 'Hermes'), importedAs: { botId: imported.id, name: imported.name } }
    ]
  }
]

// The dialog is fixed, so it portals into a transformed box that wide instead of the page's viewport.
function Stage({ width, height = 480 }: { width: number; height?: number }): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative translate-x-0 bg-background"
      style={{ width: width + 32, height }}
    >
      {/* The page is wider than the stage, so the dialog's wide-window cap would apply; hold it to the stage. */}
      <style>{`[data-slot="dialog-content"]{max-width:${width}px !important}`}</style>
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <ImportBotDialog open onOpenChange={() => {}} />
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

const seed = (sources: BotImportSource[], computer?: string) => (): void => {
  seedNewBotFixture(computer)()
  stubBots(sources === AGAIN ? [imported] : [], undefined, {
    results: { 'bots.import.sources': { sources } }
  })
}

const fixture = (
  width: number,
  sources: BotImportSource[],
  computer?: string,
  height?: number
) => ({
  width: width + 32,
  setup: seed(sources, computer),
  render: () => <Stage width={width} height={height} />
})

export const one = defineFixture(fixture(420, ONE))
export const oneNarrow = defineFixture(fixture(300, ONE))
export const several = defineFixture(fixture(420, SEVERAL))
// Waits for `find` to return an element, so a shot never captures the state before an interaction.
async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let tries = 0; tries < 40; tries++) {
    const found = find()
    if (found) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Import fixture: ${what} never appeared`)
}

const buttonNamed = (text: string) => () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === text
  )

export const severalOpen = defineFixture({
  ...fixture(420, SEVERAL),
  interact: async () => {
    const trigger = await waitFor(
      () => document.querySelector<HTMLElement>('[role="dialog"] h2 button'),
      'the source switcher'
    )
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await waitFor(() => document.querySelector('[role="menuitemradio"]'), 'the source menu')
  }
})
export const longNames = defineFixture(fixture(300, LONG, LONG_FIXTURE_COMPUTER))
export const noneFound = defineFixture(fixture(420, [], undefined, 560))
export const pictureOpen = defineFixture({
  ...fixture(420, ONE, undefined, 640),
  interact: async () => {
    const button = await waitFor(
      () =>
        document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Change picture"]'),
      'the picture button'
    )
    button.click()
    await waitFor(
      () => document.querySelector('[data-slot="popover-content"]'),
      'the picture picker'
    )
  }
})
export const importedBefore = defineFixture(fixture(420, AGAIN))
const openExport = async (): Promise<void> => {
  ;(await waitFor(buttonNamed('From export'), 'From export')).click()
  await waitFor(buttonNamed('Back'), 'Back')
}
export const fromExport = defineFixture({
  ...fixture(420, ONE, undefined, 600),
  interact: openExport
})
export const fromExportNarrow = defineFixture({
  ...fixture(300, ONE, undefined, 640),
  interact: openExport
})
