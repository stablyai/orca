import { useEffect, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { useAppStore } from '@/store'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { PortalContainerContext } from '../ui/portal-container-context'
import { Button } from '../ui/button'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import type { Bot } from '../../../../shared/bot-types'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import type { BotAccessConnector } from '../../../../shared/bots/bot-access-reach'
import { base, stub } from './bot-connectors-host-fixture'
import { useConfirmBotAccess, type BotAccessConfirm } from './bot-access-confirm'

// The fixed dialog portals into a transformed box to reproduce narrow widths inside the fixture.
// Without a width it portals to the page, so the browser viewport stands in for the app window.
const bot: Bot = { ...base, name: 'Researcher', google: false, permissionMode: 'ask' }

type Person = BotAccessConfirm['people'][number]
const dana: Person = { id: 'U-dana', name: 'Dana', identity: '@dana' }
const many: Person[] = [dana, { id: 'U-lee', name: 'Lee' }, { id: 'U-sam', name: 'Sam' }]
const longName: Person = {
  id: 'U-max',
  name: 'Maximiliana Fernández-Oyelaran',
  identity: '@maximiliana.fernandez-oyelaran'
}
const longHandle: Person = {
  ...longName,
  identity: '@maximiliana.fernandez-oyelaran.operations-north-america'
}

const PLACES: Record<BotAccessConnector, { connector: string; workspace: string | null }> = {
  slack: { connector: 'Slack', workspace: 'Acme' },
  github: { connector: 'GitHub', workspace: null },
  linear: { connector: 'Linear', workspace: 'Acme' }
}

// A paired server whose verified machine name is one long unbroken word.
const LONG_HOST = 'runtime:access-long-host'
const LONG_MACHINE = 'build-agent-0123456789abcdef0123456789abcdef.eu-west-3.compute.internal'

type FixtureLanguage = 'en' | 'zh-Hant'

/** Switches to `language` and resolves once the page's i18n provider has settled on it too.
 *  Why: the page is reused, so a zh-Hant fixture before this one leaves i18n in zh-Hant, and a
 *  confirm opened before the switch keeps the labels it was built with. */
async function settleLanguage(language: FixtureLanguage): Promise<string> {
  await setRendererUiLanguage(language)
  const locale = i18n.language
  const deadline = performance.now() + 5000
  // The provider applies the store's language (set to the same one) in its own effect.
  while (useLanguageReadiness.getState().loading || i18n.language !== locale) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out settling the fixture language on ${language}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return locale
}

function Open({
  grant,
  queued,
  languageReady
}: {
  grant: BotAccessConfirm
  /** A second request, queued behind the first while its dialog is open. */
  queued?: BotAccessConfirm
  languageReady: () => Promise<string>
}): null {
  const confirm = useConfirmBotAccess()
  useEffect(() => {
    let live = true
    // The confirm's labels are read when it opens, so it opens only in the settled language.
    void languageReady().then(() => {
      if (live) {
        void confirm(grant)
        if (queued) {
          void confirm(queued)
        }
      }
    })
    return () => {
      live = false
    }
  }, [confirm, grant, queued, languageReady])
  return null
}

// Opens on a click, as Who can ask does, so a pointer or keyboard open can be checked for focus rings.
function Trigger({
  grant,
  review
}: {
  grant: BotAccessConfirm
  review: boolean
}): React.JSX.Element {
  const confirm = useConfirmBotAccess()
  return (
    <Button
      variant="outline"
      size="sm"
      className="m-4"
      onClick={() => void confirm(grant, review ? () => {} : undefined)}
    >
      {review ? BOT_ACCESS_COPY.review : '+ Add people'}
    </Button>
  )
}

function Stage({
  width,
  grant,
  trigger,
  queued,
  languageReady
}: {
  width?: number
  grant: BotAccessConfirm
  trigger?: 'add' | 'review'
  queued?: BotAccessConfirm
  languageReady: () => Promise<string>
}): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  const confirmation = (
    <ConfirmationDialogProvider>
      {trigger ? (
        <Trigger grant={grant} review={trigger === 'review'} />
      ) : (
        <Open grant={grant} queued={queued} languageReady={languageReady} />
      )}
    </ConfirmationDialogProvider>
  )
  if (width === undefined) {
    return confirmation
  }
  return (
    <div
      ref={setBox}
      className="relative translate-x-0 bg-background"
      // At 280 the wrapped rows run taller; the capture stops at this box, not the dialog.
      style={{ width, height: width === 280 ? 460 : 340 }}
    >
      {box ? (
        <PortalContainerContext.Provider value={box}>
          {confirmation}
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

// Looks only where this fixture's dialog portals: its stage in the frame, or the page without one.
async function waitForDialog(root: HTMLElement): Promise<void> {
  const deadline = performance.now() + 3000
  while (!root.querySelector('[data-slot="dialog-content"]')) {
    // A render that already failed keeps its own error instead of this timeout's.
    if (root.ownerDocument.documentElement.dataset.fixtureState === 'error') {
      return
    }
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the access review dialog')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function accessFixture(options: {
  /** Omitted: the dialog sits in the page viewport, for window-size and zoom checks. */
  width?: 420 | 360 | 280
  people: Person[]
  bot?: Partial<Bot>
  connector?: BotAccessConnector
  /** The app's new-chat setting is the agent's own, so the starting mode can't be read. */
  unknownMode?: true
  trigger?: 'add' | 'review'
  /** Clicks the trigger once the language settles; without it a trigger waits for a person. */
  autoClick?: true
  /** Defaults to English, set and awaited before every open, even in a reused page. */
  language?: FixtureLanguage
  /** The bot runs on a paired server named `LONG_MACHINE`. */
  longHost?: true
  /** Opens on mount with a second request, for these people, queued behind it. */
  queuedPeople?: Person[]
}) {
  const { width, longHost } = options
  const language = options.language ?? 'en'
  const connector = options.connector ?? 'slack'
  const subject = {
    ...bot,
    ...options.bot,
    ...(longHost ? { hostId: LONG_HOST as Bot['hostId'] } : {})
  }
  const grant: BotAccessConfirm = {
    botName: subject.name,
    people: options.people,
    details: { bot: subject, connector },
    ...PLACES[connector]
  }
  const queued = options.queuedPeople ? { ...grant, people: options.queuedPeople } : undefined
  // One settle per render, shared by the on-mount open and the capture's wait.
  let languageSettled: Promise<string> | null = null
  const languageReady = (): Promise<string> => (languageSettled ??= settleLanguage(language))
  const dialogRoot = (frame: HTMLElement): HTMLElement =>
    width === undefined ? frame.ownerDocument.body : frame
  return defineFixture({
    // The frame's own p-4 padding sits around the stage.
    width: width === undefined ? undefined : width + 32,
    setup: () => {
      languageSettled = null
      // A fixture before this one in the same page may have listed a paired server.
      setBotHostListing({
        hosts: [
          { hostId: 'local', state: 'live' },
          ...(longHost ? [{ hostId: LONG_HOST, state: 'live' as const }] : [])
        ],
        updateNeeded: []
      })
      // The confirm reads the bot as listed now, so the host lists this scenario's bot.
      stub({ linearLinked: false, composio: false, bots: [subject] })
      if (longHost) {
        listLongHost(subject)
      }
      // The provider follows the store, so both settle on this fixture's language.
      useAppStore.setState((state) =>
        state.settings ? { settings: { ...state.settings, uiLanguage: language } } : {}
      )
      if (options.unknownMode) {
        // The agent's own permission: Orca can't read where new conversations start.
        useAppStore.setState((state) =>
          state.settings ? { settings: { ...state.settings, agentPermissionDefault: 'own' } } : {}
        )
      }
    },
    render: () => (
      <Stage
        width={width}
        grant={grant}
        trigger={options.trigger}
        queued={queued}
        languageReady={languageReady}
      />
    ),
    interact: async (frame) => {
      const locale = await languageReady()
      if (options.trigger && !options.autoClick) {
        return
      }
      if (options.trigger) {
        const trigger = frame.querySelector('button')
        if (!trigger) {
          throw new Error('Access review trigger missing')
        }
        trigger.click()
      }
      // The confirmation surface is lazy-loaded, so the dialog can mount after the first paint.
      await waitForDialog(dialogRoot(frame))
      if (i18n.language !== locale) {
        throw new Error(`The access review opened in ${i18n.language}, not ${locale}`)
      }
    }
  })
}

function listLongHost(subject: Bot): void {
  publishBots([subject], undefined, LONG_HOST)
  const environment = publicRuntimeEnvironment({ id: 'access-long-host', pairingRevision: 1 })
  const store = useAppStore.getState()
  store.setRuntimeEnvironments([environment])
  store.applyRuntimeHostStatusSnapshot({
    environmentId: environment.id,
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    verification: 'verified',
    transport: 'ready',
    status: {
      ...createCompatibleRuntimeStatusResponse(environment.id).result,
      machineName: LONG_MACHINE
    }
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
  // Every fact row at once (computer, approvals, Google, Slack), each as long as it gets.
  LongestFacts: {
    people: [longHandle],
    bot: {
      name: 'ProjectOperationsCoordinatorNorthAmerica',
      permissionMode: 'full-access',
      google: true
    } satisfies Partial<Bot>
  },
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
const longSlackReview = {
  width: 280,
  ...scenarios.OneAskSlack,
  bot: { name: 'ProjectOperationsCoordinator' },
  trigger: 'review',
  autoClick: true
} as const
export const longSlackReviewEnglish280 = accessFixture({ ...longSlackReview, language: 'en' })
export const longSlackReviewTraditionalChinese280 = accessFixture({
  ...longSlackReview,
  language: 'zh-Hant'
})
export const longestFacts280 = accessFixture({ width: 280, ...scenarios.LongestFacts })
// Size the page to the app window, e.g. 600x400 at the largest UI zoom (1.2^5): about 241x161.
export const longestFactsInWindow = accessFixture(scenarios.LongestFacts)
// Two requests in a small window: answering the first opens the second at its title.
export const queuedInWindow = accessFixture({ ...scenarios.LongestFacts, queuedPeople: [dana] })
// Closed: open Review… by keyboard or pointer to see where focus starts in a small window.
export const reviewInWindow = accessFixture({ ...scenarios.LongestFacts, trigger: 'review' })
// Every fact row, on a paired server whose machine name is one unbroken word.
export const longHost280 = accessFixture({ width: 280, ...scenarios.LongestFacts, longHost: true })
export const longHostInWindow = accessFixture({ ...scenarios.LongestFacts, longHost: true })
export const unknownPermission420 = accessFixture({ width: 420, ...scenarios.UnknownPermission })
export const unknownPermission360 = accessFixture({ width: 360, ...scenarios.UnknownPermission })
// Closed: click or Tab-and-Enter "+ Add people" to see where focus lands and whether it shows a ring.
export const mouseOpen420 = accessFixture({ width: 420, ...scenarios.OneAskSlack, trigger: 'add' })
