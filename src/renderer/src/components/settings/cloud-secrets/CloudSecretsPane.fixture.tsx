import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { CloudSecretView } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { CloudSecretList, type CloudSecretListMode } from './CloudSecretList'
import { CloudSecretsPasteEnv } from './CloudSecretsPasteEnv'
import { CloudSecretsPane, type CloudSecretRepoChoice } from './CloudSecretsPane'
import {
  FIXTURE_MEMBER,
  FIXTURE_NAMES,
  FIXTURE_SECRETS,
  FIXTURE_SOLO,
  fixtureCloudSecretsApi
} from './cloud-secrets-fixture-data'
import type { CloudSecretListModel } from './use-cloud-secrets'

const REPOS: CloudSecretRepoChoice[] = [
  { key: 'github.com/acme/web', label: 'acme/web' },
  { key: 'github.com/acme/api', label: 'acme/api' }
]
const people = { nameFor: (userId: string) => FIXTURE_NAMES[userId] ?? null }
const noop = (): void => {}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="bg-background p-6">{children}</div>
}

export const personal = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({})}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
      />
    </Frame>
  )
})

export const empty = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({ caller: FIXTURE_SOLO, secrets: {} })}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
      />
    </Frame>
  )
})

export const sharedAdmin = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({})}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
        initialTab="org"
      />
    </Frame>
  )
})

export const sharedMember = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({ caller: FIXTURE_MEMBER })}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
        initialTab="org"
      />
    </Frame>
  )
})

export const repo = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({})}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
        initialTab="repo"
      />
    </Frame>
  )
})

export const repoNone = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({})}
        repos={[]}
        people={people}
        onSetUpAgent={noop}
        onAddProject={noop}
        initialTab="repo"
      />
    </Frame>
  )
})

export const effective = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({})}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
        initialTab="effective"
      />
    </Frame>
  )
})

export const effectiveEmpty = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({ caller: FIXTURE_SOLO, secrets: {} })}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
        initialTab="effective"
      />
    </Frame>
  )
})

export const loading = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({ pending: true })}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
      />
    </Frame>
  )
})

export const loadFailed = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPane
        api={fixtureCloudSecretsApi({ listError: 'unavailable' })}
        repos={REPOS}
        people={people}
        onSetUpAgent={noop}
      />
    </Frame>
  )
})

function listModel(
  secrets: CloudSecretView[],
  overrides: Partial<CloudSecretListModel> = {}
): CloudSecretListModel {
  return {
    list: { status: 'ready', value: secrets },
    reload: noop,
    put: async () => null,
    remove: async () => null,
    batch: async () => ({ secrets: [], deleted: [], errors: [] }),
    ...overrides
  }
}

function list(
  mode: CloudSecretListMode,
  options: { saved?: string[]; model?: CloudSecretListModel } = {}
) {
  return (
    <Frame>
      <CloudSecretList
        model={options.model ?? listModel(FIXTURE_SECRETS.personal)}
        canWrite
        people={{ ...people, viewerUserId: 'u_me' }}
        emptyTitle="No personal secrets yet"
        emptyDetail="Add one or paste a .env file."
        initialMode={mode}
        initialSaved={options.saved}
        onSetUpAgent={noop}
        description="Only you get these, in every Orca Cloud workspace you start."
      />
    </Frame>
  )
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function fillAddForm(frame: HTMLElement, reveal: boolean): Promise<void> {
  const [name, value] = frame.querySelectorAll<HTMLInputElement>('form input')
  typeInto(name, 'DATABASE_URL')
  typeInto(value, 'postgres://app:hunter2@db.internal/app')
  if (reveal) {
    frame.querySelector<HTMLButtonElement>('button[aria-pressed]')?.click()
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
}

export const savedFlash = defineFixture({
  width: 760,
  render: () => list({ kind: 'idle' }, { saved: ['GITHUB_PACKAGES_TOKEN'] })
})

export const addingRevealed = defineFixture({
  width: 760,
  render: () => list({ kind: 'edit', target: { kind: 'add' } }),
  interact: (frame) => fillAddForm(frame, true)
})

export const addingMasked = defineFixture({
  width: 760,
  render: () => list({ kind: 'edit', target: { kind: 'add' } }),
  interact: (frame) => fillAddForm(frame, false)
})

export const saving = defineFixture({
  width: 760,
  render: () =>
    list(
      { kind: 'edit', target: { kind: 'add' } },
      { model: listModel(FIXTURE_SECRETS.personal, { put: () => new Promise(() => {}) }) }
    ),
  interact: async (frame) => {
    await fillAddForm(frame, false)
    frame.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

export const saveRefused = defineFixture({
  width: 760,
  render: () =>
    list(
      { kind: 'edit', target: { kind: 'add' } },
      {
        model: listModel(FIXTURE_SECRETS.personal, {
          put: async () => 'subscription_token_refused'
        })
      }
    ),
  interact: async (frame) => {
    const [name, value] = frame.querySelectorAll<HTMLInputElement>('form input')
    typeInto(name, 'ANTHROPIC_API_KEY')
    typeInto(value, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjaGF0Z3B0In0.c2lnbmF0dXJlX3NpZw')
    await new Promise((resolve) => setTimeout(resolve, 30))
    frame.querySelector<HTMLButtonElement>('form button[type="submit"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})

export const replacing = defineFixture({
  width: 760,
  render: () =>
    list({
      kind: 'edit',
      target: { kind: 'replace', name: 'ANTHROPIC_API_KEY', hint: 'x7Qa' }
    })
})

const PASTE = [
  '# acme/web local env',
  'export DATABASE_URL=postgres://localhost/app',
  'STRIPE_SECRET_KEY="sk_test_51Hk…"',
  'PRIVATE_KEY="-----BEGIN KEY-----',
  'MIIEv…',
  '-----END KEY-----"',
  'PATH=/usr/local/bin',
  'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc',
  'NEXT_PUBLIC_URL=http://localhost:3000',
  'NEXT_PUBLIC_URL=https://acme.dev',
  'sentry-auth-token=sntrys_abc',
  'oops this is not a line'
].join('\n')

export const pastePreview = defineFixture({
  width: 760,
  render: () => (
    <Frame>
      <CloudSecretsPasteEnv
        existingNames={FIXTURE_SECRETS.repo.map((secret) => secret.name)}
        onSave={async () => ({ secrets: [], deleted: [], errors: [] })}
        onCancel={noop}
        initialText={PASTE}
      />
    </Frame>
  )
})
