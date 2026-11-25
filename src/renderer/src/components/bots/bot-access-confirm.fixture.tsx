import { useEffect, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { PortalContainerContext } from '../ui/portal-container-context'
import { Button } from '../ui/button'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import type { Bot } from '../../../../shared/bot-types'
import type { BotAccessConnector } from '../../../../shared/bots/bot-access-reach'
import { base, stub } from './bot-connectors-host-fixture'
import { useConfirmBotAccess, type BotAccessConfirm } from './bot-access-confirm'

// The Give access confirm, open, at 420 (its own cap) and 360. The dialog is fixed, so it portals
// into a transformed box of that width, which it fills, instead of the page's wide viewport.
const bot: Bot = { ...base, name: 'Researcher', google: false, permissionMode: 'ask' }

type Person = BotAccessConfirm['people'][number]
const dana: Person = { id: 'U-dana', name: 'Dana', identity: '@dana' }
const many: Person[] = [dana, { id: 'U-lee', name: 'Lee' }, { id: 'U-sam', name: 'Sam' }]
const longName: Person = {
  id: 'U-max',
  name: 'Maximiliana Fernández-Oyelaran',
  identity: '@maximiliana.fernandez-oyelaran'
}

const PLACES: Record<BotAccessConnector, { connector: string; workspace: string | null }> = {
  slack: { connector: 'Slack', workspace: 'Acme' },
  github: { connector: 'GitHub', workspace: null },
  linear: { connector: 'Linear', workspace: 'Acme' }
}

function Open({ grant }: { grant: BotAccessConfirm }): null {
  const confirm = useConfirmBotAccess()
  useEffect(() => {
    void confirm(grant)
  }, [confirm, grant])
  return null
}

// Opens on a click, as Who can ask does, so a pointer or keyboard open can be checked for focus rings.
function Trigger({ grant }: { grant: BotAccessConfirm }): React.JSX.Element {
  const confirm = useConfirmBotAccess()
  return (
    <Button variant="outline" size="sm" className="m-4" onClick={() => void confirm(grant)}>
      + Add people
    </Button>
  )
}

function Stage({
  width,
  grant,
  trigger
}: {
  width: number
  grant: BotAccessConfirm
  trigger?: true
}): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <div ref={setBox} className="relative h-[340px] translate-x-0 bg-background" style={{ width }}>
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <ConfirmationDialogProvider>
            {trigger ? <Trigger grant={grant} /> : <Open grant={grant} />}
          </ConfirmationDialogProvider>
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

function accessFixture(options: {
  width: 420 | 360
  people: Person[]
  bot?: Partial<Bot>
  connector?: BotAccessConnector
  /** The app's new-chat setting is the agent's own, so the starting mode can't be read. */
  unknownMode?: true
  /** Closed, behind a "+ Add people" button that opens it. */
  trigger?: true
}) {
  const connector = options.connector ?? 'slack'
  const subject = { ...bot, ...options.bot }
  const grant: BotAccessConfirm = {
    botName: subject.name,
    people: options.people,
    details: { bot: subject, connector },
    ...PLACES[connector]
  }
  return defineFixture({
    // The frame's own p-4 padding sits around the stage.
    width: options.width + 32,
    setup: () => {
      // The confirm reads the bot as listed now, so the host lists this scenario's bot.
      stub({ linearLinked: false, composio: false, bots: [subject] })
      if (options.unknownMode) {
        // The agent's own permission: Orca can't read where new conversations start.
        useAppStore.setState((state) =>
          state.settings ? { settings: { ...state.settings, agentPermissionDefault: 'own' } } : {}
        )
      }
    },
    render: () => <Stage width={options.width} grant={grant} trigger={options.trigger} />
  })
}

const scenarios = {
  OneAskSlack: { people: [dana] },
  OneFullGoogleGitHub: {
    people: [dana],
    bot: { permissionMode: 'full-access', google: true } satisfies Partial<Bot>,
    connector: 'github' as const
  },
  ThreePeople: { people: many },
  LongName: { people: [longName] },
  UnknownPermission: {
    people: [dana],
    bot: { permissionMode: undefined },
    unknownMode: true as const
  }
}

export const oneAskSlack420 = accessFixture({ width: 420, ...scenarios.OneAskSlack })
export const oneAskSlack360 = accessFixture({ width: 360, ...scenarios.OneAskSlack })
export const oneFullGoogleGitHub420 = accessFixture({
  width: 420,
  ...scenarios.OneFullGoogleGitHub
})
export const oneFullGoogleGitHub360 = accessFixture({
  width: 360,
  ...scenarios.OneFullGoogleGitHub
})
export const threePeople420 = accessFixture({ width: 420, ...scenarios.ThreePeople })
export const threePeople360 = accessFixture({ width: 360, ...scenarios.ThreePeople })
export const longName420 = accessFixture({ width: 420, ...scenarios.LongName })
export const longName360 = accessFixture({ width: 360, ...scenarios.LongName })
export const unknownPermission420 = accessFixture({ width: 420, ...scenarios.UnknownPermission })
export const unknownPermission360 = accessFixture({ width: 360, ...scenarios.UnknownPermission })
// Closed: click or Tab-and-Enter "+ Add people" to see where focus lands and whether it shows a ring.
export const mouseOpen420 = accessFixture({ width: 420, ...scenarios.OneAskSlack, trigger: true })
