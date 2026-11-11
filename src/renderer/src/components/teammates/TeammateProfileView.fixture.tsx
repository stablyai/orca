import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TeammateProfile } from '../../../../shared/cloud-workspaces/team-presence-wire'
import { FIXTURE_NOW, workspace } from '../cloud-workspaces/cloud-workspaces.test-fixture'
import { TeammateProfileView, type TeammateProfileViewProps } from './TeammateProfileView'

const DAYS = 182
// Fixtures render offline: a self-contained stand-in for a provider profile picture.
const PICTURE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23f6c38f'/><stop offset='1' stop-color='%23c0713d'/></linearGradient></defs><rect width='64' height='64' fill='url(%23g)'/><circle cx='32' cy='26' r='12' fill='%23fff3e6'/><rect x='14' y='42' width='36' height='22' rx='11' fill='%23fff3e6'/></svg>"

/** A believable work pattern: weekdays busy, weekends quiet, a vacation gap. Deterministic. */
function levels(): number[] {
  const out: number[] = []
  for (let i = 0; i < DAYS; i++) {
    const weekday = (i + 3) % 7
    const vacation = i > 60 && i < 72
    const seed = (i * 37 + 11) % 9
    out.push(
      vacation || weekday === 0 || weekday === 6 ? (seed === 0 ? 1 : 0) : Math.min(4, seed % 5)
    )
  }
  return out
}

function startDate(): string {
  const d = new Date(FIXTURE_NOW - (DAYS - 1) * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function profile(overrides: Partial<TeammateProfile> = {}): TeammateProfile {
  const lv = levels()
  return {
    userId: 'user_grace',
    self: false,
    name: 'Grace Hopper',
    usage: {
      start: startDate(),
      levels: lv,
      activeDays: lv.filter((l) => l > 0).length,
      own: null
    },
    recentWorkspaces: [
      workspace({
        title: 'Checkout retries',
        ownerUserId: 'user_grace',
        createdBy: 'user_grace',
        access: 'can_open'
      }),
      workspace({
        repo: { url: 'https://github.com/acme/payments.git', branch: 'refund-webhooks' },
        ownerUserId: 'user_grace',
        createdBy: 'user_grace',
        access: 'can_open',
        status: 'suspended',
        lastActivityAt: FIXTURE_NOW - 3 * 3_600_000
      })
    ],
    pokes: { enabled: true, teammateEnabled: true },
    ...overrides
  }
}

const base: TeammateProfileViewProps = {
  userId: 'user_grace',
  name: 'Grace Hopper',
  email: 'grace@acme.dev',
  role: 'admin',
  profile: profile(),
  error: null,
  poke: { kind: 'idle' },
  now: FIXTURE_NOW,
  onRetry: () => {},
  onPoke: () => {},
  onOpenWorkspace: () => {},
  onShowAllWorkspaces: () => {},
  onTurnOnPokes: () => {}
}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-border bg-background p-6">{children}</div>
}

/** A teammate with Pokes on both sides: heatmap levels only, team workspaces, Poke button. */
export const teammate = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView {...base} />
    </Frame>
  )
})

/** A teammate with a provider profile picture (falls back to initials if it fails to load). */
export const withPicture = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView {...base} pictureUrl={PICTURE} />
    </Frame>
  )
})

/** Your own profile: amounts in the hover caption, private workspaces included, no Poke. */
export const self = defineFixture({
  width: 600,
  render: () => {
    const lv = levels()
    return (
      <Frame>
        <TeammateProfileView
          {...base}
          userId="user_ada"
          name="Ada Lovelace"
          email="ada@acme.dev"
          role="owner"
          profile={profile({
            userId: 'user_ada',
            self: true,
            name: 'Ada Lovelace',
            usage: {
              start: startDate(),
              levels: lv,
              activeDays: lv.filter((l) => l > 0).length,
              own: {
                computeMs: lv.map((l) => l * 1_800_000),
                usdMicros: lv.map((l) => l * 500_000)
              }
            },
            recentWorkspaces: [workspace({ title: 'Flaky e2e repro', visibility: 'private' })],
            pokes: { enabled: true, teammateEnabled: null }
          })}
        />
      </Frame>
    )
  }
})

/** Pokes off for the viewer: the footer points to Settings → Experimental. */
export const pokesOff = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView
        {...base}
        profile={profile({ pokes: { enabled: false, teammateEnabled: null } })}
      />
    </Frame>
  )
})

/** Teammate hasn't opted in; also a new teammate with no usage and nothing shared yet. */
export const quietTeammate = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView
        {...base}
        name="Linus Park"
        email="linus@acme.dev"
        role="member"
        userId="user_linus"
        profile={profile({
          userId: 'user_linus',
          usage: {
            start: startDate(),
            levels: Array.from({ length: DAYS }, () => 0),
            activeDays: 0,
            own: null
          },
          recentWorkspaces: [],
          pokes: { enabled: true, teammateEnabled: false }
        })}
      />
    </Frame>
  )
})

/** A teammate who hasn't turned on "Pokes and activity": no heatmap, a plain line instead. */
export const activityNotShared = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView
        {...base}
        profile={profile({ usage: null, pokes: { enabled: true, teammateEnabled: false } })}
      />
    </Frame>
  )
})

/** Rate limited after a poke. */
export const pokeCooldown = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView
        {...base}
        poke={{ kind: 'refused', message: 'You just poked Grace Hopper. Try again in a minute.' }}
      />
    </Frame>
  )
})

export const loading = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView {...base} profile={null} />
    </Frame>
  )
})

export const loadError = defineFixture({
  width: 600,
  render: () => (
    <Frame>
      <TeammateProfileView
        {...base}
        profile={null}
        error="Can’t reach Orca Cloud right now. Check your connection."
      />
    </Frame>
  )
})
