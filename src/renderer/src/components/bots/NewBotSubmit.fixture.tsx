import { useAppStore } from '@/store'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { BOT_TEMPLATES } from '../../../../shared/bots/bot-templates'
import { BOT_PURPOSE_MAX_LENGTH, templateProposal } from '../../../../shared/bots/bot-proposal'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  LONG_FIXTURE_COMPUTER,
  NewBotFixtureStage,
  newBotFixture,
  seedNewBotFixture,
  typeInto
} from './new-bot-stage-fixture'

const NAME_FIELD = 'input[aria-label="Name"]'

function shortcut(target: HTMLElement, repeat = false): void {
  const mac = navigator.userAgent.includes('Mac')
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      metaKey: mac,
      ctrlKey: !mac,
      repeat
    })
  )
}

function describedAlert(field: HTMLElement | null): string | null {
  const id = field?.getAttribute('aria-describedby')
  const message = id ? document.getElementById(id) : null
  return field?.getAttribute('aria-invalid') === 'true' && message?.role === 'alert'
    ? message.textContent
    : null
}

function countLocalCreates(): () => number {
  let creates = 0
  const runtime = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: (request: Parameters<typeof runtime.call>[0]) => {
      if (request.method === 'bots.create') {
        creates += 1
        return new Promise(() => {})
      }
      return runtime.call(request)
    }
  })
  return () => creates
}

function submitReview(
  width: 340 | 480,
  stage: 'idle' | 'invalid' | 'corrected' | 'agent-focus' | 'agent-ready' | 'busy' | 'reopen'
) {
  let creates = (): number => 0
  return defineFixture({
    ...newBotFixture(width),
    render: () => <NewBotFixtureStage width={width} reopen={stage === 'reopen'} />,
    setup: () => {
      seedNewBotFixture(undefined, stage === 'busy' ? undefined : [])()
      creates = countLocalCreates()
    },
    interact: async (frame) => {
      const create = frame.querySelector<HTMLButtonElement>('button[type="submit"]')
      const name = frame.querySelector<HTMLInputElement>(NAME_FIELD)
      if (!create || create.disabled || !name || frame.querySelector('[aria-invalid="true"]')) {
        throw new Error('An empty New bot dialog must open with Create enabled and no errors')
      }
      if (stage === 'idle') {
        return
      }
      if (stage === 'busy') {
        await typeInto(NAME_FIELD, 'Maple')()
        const computer = frame.querySelector<HTMLInputElement>('input[role="combobox"]')
        computer?.focus()
        await new Promise(requestAnimationFrame)
        if (computer?.getAttribute('aria-expanded') !== 'true') {
          throw new Error('Computer must open when focused before any validation')
        }
        shortcut(computer)
        await new Promise(requestAnimationFrame)
        if (creates() !== 0 || computer.getAttribute('aria-expanded') !== 'false') {
          throw new Error('The open Computer picker must handle Enter without submitting')
        }
        shortcut(name, true)
        if (creates() !== 0) {
          throw new Error('A held submit shortcut cannot create a bot')
        }
        create.click()
        shortcut(name)
        await new Promise(requestAnimationFrame)
        shortcut(name, true)
        if (creates() !== 1 || !create.disabled || !create.querySelector('.animate-spin')) {
          throw new Error('Creating must show the busy state and reject repeat submissions')
        }
        return
      }
      create.focus()
      if (stage === 'invalid') {
        create.click()
      } else {
        shortcut(create)
      }
      const agent = frame.querySelector<HTMLElement>('[role="group"][aria-label="Agent"]')
      if (
        creates() !== 0 ||
        document.activeElement !== name ||
        describedAlert(name) !== 'Add a name' ||
        describedAlert(agent) !== 'No agents available' ||
        frame.querySelectorAll('[aria-invalid="true"]').length !== 2
      ) {
        throw new Error('Invalid submit must announce Name and Agent, focus Name, and skip create')
      }
      if (stage === 'invalid') {
        return
      }
      if (stage === 'reopen') {
        name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await new Promise(requestAnimationFrame)
        const reopenButton = frame.querySelector<HTMLButtonElement>('button:not([hidden])')
        reopenButton?.click()
        await new Promise(requestAnimationFrame)
        if (
          frame.querySelector('[aria-invalid="true"]') ||
          document.activeElement !== frame.querySelector(NAME_FIELD) ||
          frame.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled !== false
        ) {
          throw new Error('Dismissing and reopening must reset validation and restore focus')
        }
        return
      }
      await typeInto(NAME_FIELD, 'Maple')()
      if (name.hasAttribute('aria-invalid') || describedAlert(agent) !== 'No agents available') {
        throw new Error('Typing a name must clear only the name error')
      }
      if (stage === 'agent-focus' || stage === 'agent-ready') {
        shortcut(name)
        if (document.activeElement !== agent || creates() !== 0) {
          throw new Error('With Name valid, submit must focus the Agent error and skip create')
        }
      }
      if (stage === 'agent-ready') {
        seedNewBotFixture()()
        creates = countLocalCreates()
        await new Promise(requestAnimationFrame)
        if (
          document.activeElement !== agent ||
          agent?.hasAttribute('aria-invalid') ||
          !agent?.querySelector('button:not([disabled])') ||
          creates() !== 0
        ) {
          throw new Error(
            'An available Agent must clear validation and keep focus without creating'
          )
        }
      }
    }
  })
}

export const submitIdle340 = submitReview(340, 'idle')
export const submitIdle480 = submitReview(480, 'idle')
export const submitInvalid340 = submitReview(340, 'invalid')
export const submitInvalid480 = submitReview(480, 'invalid')
export const submitCorrected340 = submitReview(340, 'corrected')
export const submitCorrected480 = submitReview(480, 'corrected')
export const submitAgentFocus340 = submitReview(340, 'agent-focus')
export const submitAgentFocus480 = submitReview(480, 'agent-focus')
export const submitAgentReady340 = submitReview(340, 'agent-ready')
export const submitBusy340 = submitReview(340, 'busy')
export const submitBusy480 = submitReview(480, 'busy')
export const submitReopen340 = submitReview(340, 'reopen')

function pendingReview(width: 340 | 480, pending: 'agents' | 'picture', recover = false) {
  let creates = (): number => 0
  return defineFixture({
    ...newBotFixture(width),
    setup: () => {
      seedNewBotFixture()()
      creates = countLocalCreates()
      if (pending === 'agents') {
        useAppStore.setState({
          detectedAgentIds: null,
          localDetectedAgentIdsByContext: {},
          ensureDetectedAgents: () => new Promise(() => {})
        })
      }
    },
    interact: async (frame) => {
      await typeInto(NAME_FIELD, 'Maple')()
      if (pending === 'picture') {
        const decode = window.createImageBitmap
        window.createImageBitmap = () => new Promise<ImageBitmap>(() => {})
        try {
          const clipboardData = new DataTransfer()
          clipboardData.items.add(
            new File(['seeded picture'], 'fixture.png', { type: 'image/png' })
          )
          frame
            .querySelector('[role="dialog"]')
            ?.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }))
        } finally {
          window.createImageBitmap = decode
        }
        await new Promise(requestAnimationFrame)
      }
      const create = frame.querySelector<HTMLButtonElement>('button[type="submit"]')
      create?.focus()
      create?.click()
      const expected = pending === 'agents' ? 'Finding agents…' : 'Picture loading…'
      if (
        !create ||
        create.disabled ||
        document.activeElement !== create ||
        frame.querySelector('[aria-invalid="true"]') ||
        frame.querySelector('[role="status"]')?.textContent !== expected
      ) {
        throw new Error(`Create must show ${expected} as inline status and leave focus in place`)
      }
      if (recover) {
        const agents = ['claude'] as const
        useAppStore.setState({
          detectedAgentIds: [...agents],
          localDetectedAgentIdsByContext: { host: [...agents], 'host\u0000all-agents': [...agents] }
        })
        await new Promise(requestAnimationFrame)
        shortcut(create, true)
        for (const target of [frame.querySelector(NAME_FIELD), create]) {
          if (
            target?.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
                repeat: true
              })
            ) !== false
          ) {
            throw new Error('Held Enter must be cancelled on Name and Create')
          }
        }
        if (creates() !== 0 || frame.querySelector('[role="status"]')) {
          throw new Error('Detection must clear the status and wait for a fresh submit')
        }
        shortcut(create)
        await new Promise(requestAnimationFrame)
        if (creates() !== 1) {
          throw new Error('A new shortcut after detection must create exactly once')
        }
      }
    }
  })
}

export const submitFinding340 = pendingReview(340, 'agents')
export const submitFinding480 = pendingReview(480, 'agents')
export const submitReading340 = pendingReview(340, 'picture')
export const submitReading480 = pendingReview(480, 'picture')
export const submitAfterFinding340 = pendingReview(340, 'agents', true)

function blockedTemplateReview(uiLanguage: 'de' | 'ru' | 'en') {
  const hostId = toRuntimeExecutionHostId('test-runner')
  const proposal = templateProposal(BOT_TEMPLATES[0], { name: '' })
  let creates = (): number => 0
  return defineFixture({
    width: 372,
    setup: () => {
      seedNewBotFixture()()
      creates = countLocalCreates()
      useAppStore.setState((state) => ({
        runtimeEnvironments: [
          {
            id: 'test-runner',
            name: LONG_FIXTURE_COMPUTER,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: null,
            runtimeId: null,
            endpoints: [],
            preferredEndpointId: 'test-runner'
          }
        ],
        settings: state.settings && { ...state.settings, uiLanguage }
      }))
    },
    render: () => (
      <NewBotFixtureStage width={340} height={900} proposal={proposal} offerHostId={hostId} />
    ),
    interact: async (frame) => {
      await i18n.changeLanguage(await loadRendererUiLanguage(uiLanguage))
      await typeInto('textarea', 'Summarize fixture events for the example studio. '.repeat(21))()
      const create = frame.querySelector<HTMLButtonElement>('button[type="submit"]')
      create?.click()
      const alerts = [...frame.querySelectorAll<HTMLElement>('[role="alert"]')]
      if (
        creates() !== 0 ||
        frame.querySelectorAll('[aria-invalid="true"]').length !== 3 ||
        alerts.length !== 3 ||
        alerts.some(
          (alert) => alert.scrollHeight > Number.parseFloat(getComputedStyle(alert).lineHeight) + 1
        )
      ) {
        throw new Error('An empty name, over-limit identity and offline computer must show errors')
      }
      if (uiLanguage !== 'en') {
        return
      }
      await typeInto(NAME_FIELD, 'Maple')()
      await typeInto('textarea', 'Summarize fixture events')()
      create?.click()
      const computer = frame.querySelector<HTMLInputElement>('input[role="combobox"]')
      if (
        !computer ||
        document.activeElement !== computer ||
        computer.getAttribute('aria-expanded') !== 'false' ||
        computer.getAttribute('aria-describedby')?.split(' ').length !== 2 ||
        creates() !== 0
      ) {
        throw new Error(
          'Computer validation must focus the closed picker and preserve its accessible label'
        )
      }
      computer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await new Promise(requestAnimationFrame)
      const list = document.getElementById(computer.getAttribute('aria-controls') ?? '')
      const readyComputer = list?.querySelector('[role="option"]:not([data-current])')
      if (!readyComputer) {
        throw new Error('The Computer picker must offer the ready local computer')
      }
      readyComputer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
      await new Promise(requestAnimationFrame)
      shortcut(computer)
      await new Promise(requestAnimationFrame)
      if (frame.querySelector('[aria-invalid="true"]') || creates() !== 0) {
        throw new Error('Choosing a ready computer must clear the error without creating')
      }
      create?.click()
      await new Promise(requestAnimationFrame)
      if (creates() !== 1) {
        throw new Error('A fresh submit must create once on the selected local computer')
      }
    }
  })
}

export const submitBlockedGerman340 = blockedTemplateReview('de')
export const submitBlockedRussian340 = blockedTemplateReview('ru')
export const submitSwitchComputer340 = blockedTemplateReview('en')

let templateCreates = (): number => 0
export const submitUntouchedIdentity340 = defineFixture({
  ...newBotFixture(340),
  setup: () => {
    seedNewBotFixture()()
    templateCreates = countLocalCreates()
  },
  render: () => (
    <NewBotFixtureStage
      width={340}
      proposal={{
        ...templateProposal(BOT_TEMPLATES[0]),
        watches: 'Example studio requests. '.repeat(12).trim(),
        does: 'Sorts each request and drafts a reply. '.repeat(13).slice(0, 499).trim(),
        reports: 'Here, every weekday morning. '.repeat(7).slice(0, 199).trim()
      }}
    />
  ),
  interact: async (frame) => {
    const identity = frame.querySelector('textarea')
    frame.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await new Promise(requestAnimationFrame)
    if (
      !identity ||
      identity.value.length <= BOT_PURPOSE_MAX_LENGTH ||
      identity.ariaInvalid ||
      templateCreates() !== 1
    ) {
      throw new Error('An untouched template identity may exceed the typed limit')
    }
  }
})
