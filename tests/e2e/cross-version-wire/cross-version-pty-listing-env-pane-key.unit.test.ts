import { beforeAll, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * A PTY listing row now carries `envPaneKey`: the pane key the daemon or SSH relay exported into
 * the process. The daemon outlives app updates and a relay updates on its own schedule, so both
 * skews are normal. This pairs the main-side listing readers of the newest release with the
 * working tree's, over the same rows, to pin Rule 1: an old reader ignores the field, and a new
 * reader handed a row from a host that predates it reads exactly what that host published.
 */
const SUITE_TIMEOUT_MS = 180_000
const ENV_PANE_KEY = 'tab-old:11111111-1111-4111-8111-111111111111'

type Row = Record<string, unknown>
type Readers = {
  label: string
  /** The admission class itself, so one module resolved twice cannot pass as two builds. */
  admission: unknown
  admit: (row: Row) => Row
  mapSsh: (rows: Row[]) => Row[]
}

const DAEMON_ROW: Row = {
  id: 'repo::/worktree@@shell',
  cwd: '/worktree',
  title: 'shell',
  worktreeId: 'repo::/worktree',
  incarnationId: '50000000-0000-4000-8000-000000000001',
  terminalHandle: 'term_50000000-0000-4000-8000-000000000001'
}

function withoutField(row: Row): Row {
  const { envPaneKey: _envPaneKey, ...rest } = row
  return rest
}

async function loadReaders(ref: string | null): Promise<Readers> {
  const [admission, ssh] =
    ref === null
      ? await Promise.all([
          import('../../../src/main/providers/pty-process-list-admission'),
          import('../../../src/main/providers/ssh-agent-session-process-list')
        ])
      : await materializeReleaseCheckout(ref).then((checkout) =>
          Promise.all([
            importReleaseCheckoutModule(
              checkout,
              'src/main/providers/pty-process-list-admission.ts'
            ),
            importReleaseCheckoutModule(
              checkout,
              'src/main/providers/ssh-agent-session-process-list.ts'
            )
          ])
        )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dynamic import is typed by path; both builds export this class under the same name.
  const Admission = admission.PtyProcessListAdmission as new () => { admit: (row: Row) => Row }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both builds export this mapper under the same name and signature.
  const map = ssh.mapSshPtyProcessList as (rows: Row[], toApp: (id: string) => string) => Row[]
  return {
    label: ref ?? 'current',
    admission: Admission,
    admit: (row) => new Admission().admit(row),
    mapSsh: (rows) => map(rows, (id) => `ssh:conn-1@@${id}`)
  }
}

let oldReaders: Readers
let newReaders: Readers

beforeAll(async () => {
  ;[oldReaders, newReaders] = await Promise.all([
    loadReaders(resolveBaselineReleaseRef()),
    loadReaders(null)
  ])
}, SUITE_TIMEOUT_MS)

describe('cross-version PTY listing envPaneKey', () => {
  it('pairs two distinct builds', () => {
    expect(oldReaders.admission).not.toBe(newReaders.admission)
  })

  it('an OLD app reads a new daemon row as it reads the same row without the field', () => {
    const admitted = oldReaders.admit({ ...DAEMON_ROW, envPaneKey: ENV_PANE_KEY })
    // Whatever the baseline does with the field, it must not change how it reads the rest.
    expect(withoutField(admitted)).toEqual(oldReaders.admit(DAEMON_ROW))
  })

  it('an OLD app reads a new relay row as it reads the same row without the field', () => {
    const [mapped] = oldReaders.mapSsh([{ ...DAEMON_ROW, envPaneKey: ENV_PANE_KEY }])
    const [baseline] = oldReaders.mapSsh([DAEMON_ROW])
    expect(withoutField(mapped!)).toEqual(withoutField(baseline!))
  })

  it('a NEW app reads an old host row, which has no field, without inventing one', () => {
    expect(newReaders.admit(DAEMON_ROW)).toEqual(DAEMON_ROW)
    expect(newReaders.mapSsh([DAEMON_ROW])[0]).not.toHaveProperty('envPaneKey')
  })

  it('a NEW app keeps the field a new host publishes', () => {
    expect(newReaders.admit({ ...DAEMON_ROW, envPaneKey: ENV_PANE_KEY })).toMatchObject({
      envPaneKey: ENV_PANE_KEY
    })
  })
})
