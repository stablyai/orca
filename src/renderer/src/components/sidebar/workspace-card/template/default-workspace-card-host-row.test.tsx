import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CARD_PRIMITIVES } from './card-primitives'
import { cardElement, compileCardTemplate } from './card-template-compiler'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'

// The default card's own vars, read through a probe that prints the two JA-13 decisions.
const probe = compileCardTemplate(
  {
    ...DEFAULT_WORKSPACE_CARD_TEMPLATE,
    defs: undefined,
    root: {
      el: 'Probe',
      props: {
        host: '=vars.hostLabel',
        identity: '=vars.identityInMeta',
        branch: '=vars.branch'
      }
    }
  },
  {
    ...CARD_PRIMITIVES,
    Probe: cardElement<null>(['host', 'identity', 'branch'], (props) => (
      <i>{`${String(props.host)}|${String(props.identity)}|${String(props.branch)}`}</i>
    ))
  }
)

type Host = { kind: string; contextLabel: string | null; cloud?: boolean; stateWord?: boolean }

function facts(host: Host, title: string, style = 'new') {
  return {
    ws: {
      id: 'w',
      name: title,
      title,
      kind: 'git',
      path: '/p',
      branch: 'ja-hello',
      identity: 'ja-hello',
      isMain: false,
      isSparse: false,
      detachedHead: false,
      comment: ''
    },
    repo: { id: 'r', name: 'Hello-World', ssh: false },
    host: { cloud: false, stateWord: false, ...host, runtimeDisconnected: false },
    git: { conflictOperation: null, remoteBranchConflict: null, cacheTimerActive: false },
    review: null,
    links: { count: 0, issue: false, linearIssue: false, jiraIssue: false },
    provenance: { automation: false, cli: false },
    ports: { count: 0 },
    lineage: { childCount: 0, collapsed: false, toggleable: false },
    place: {
      isActive: false,
      inPinnedSection: false,
      hideRepoBadge: false,
      showProjectName: false,
      affiliateList: false,
      deleteQuickAction: false
    },
    options: {
      style,
      show: {
        host: true,
        branch: true,
        status: true,
        ports: true,
        issue: true,
        linearIssue: true,
        jiraIssue: true,
        pr: true,
        comment: true,
        automation: true,
        cli: true,
        inlineAgents: false
      },
      agentRows: 'full'
    },
    env: { projectGroups: false }
  }
}

const read = (f: ReturnType<typeof facts>): string =>
  renderToStaticMarkup(<>{probe.render(f, null).content}</>)

describe('default workspace card host row (JA-13)', () => {
  it('names the host only on the exception: Orca Cloud yes, this computer no', () => {
    expect(read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, 'x'))).toContain(
      'Orca Cloud|'
    )
    expect(read(facts({ kind: 'local', contextLabel: 'Local Mac' }, 'x'))).toContain('null|')
  })

  it('does not repeat the name as the branch line', () => {
    expect(read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, 'ja-hello'))).toContain(
      '|false|'
    )
    expect(read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, 'Fix login'))).toContain(
      '|true|'
    )
  })

  it('classic cards drop the branch line when it is the name too', () => {
    const classic = (title: string): string =>
      read(facts({ kind: 'runtime', contextLabel: 'Orca Cloud' }, title, 'classic'))
    expect(classic('ja-hello')).toMatch(/\|false<\/i>$/)
    expect(classic('Fix login')).toMatch(/\|true<\/i>$/)
  })
})

// Line 2's presence, read through the same compiled vars.
const line2Probe = compileCardTemplate(
  {
    ...DEFAULT_WORKSPACE_CARD_TEMPLATE,
    defs: undefined,
    root: { el: 'Line2', props: { line2: '=vars.hasMetaRow' } }
  },
  {
    ...CARD_PRIMITIVES,
    Line2: cardElement<null>(['line2'], (props) => <b>{String(props.line2)}</b>)
  }
)
const line2 = (f: ReturnType<typeof facts>): string =>
  renderToStaticMarkup(<>{line2Probe.render(f, null).content}</>)

describe('CLOUD-ROW-DUP-TAG: no host pill on an Orca Cloud row', () => {
  const cloud = { kind: 'runtime', contextLabel: 'Orca Cloud', cloud: true }

  it('an owned or paired cloud row has no host pill; its cloud mark names the host', () => {
    expect(read(facts(cloud, 'codex sandbox2'))).toMatch(/^<i>null\|/)
  })

  it('SSH and other remote hosts keep theirs', () => {
    expect(read(facts({ kind: 'ssh', contextLabel: 'devbox' }, 'x'))).toContain('devbox|')
    expect(read(facts({ kind: 'runtime', contextLabel: 'build-server' }, 'x'))).toContain(
      'build-server|'
    )
  })

  it('line 2 keeps the branch, and stays for a state word with nothing else on it', () => {
    expect(read(facts(cloud, 'codex sandbox2'))).toContain('|true|')
    expect(line2(facts(cloud, 'ja-hello'))).toBe('<b>false</b>')
    expect(line2(facts({ ...cloud, stateWord: true }, 'ja-hello'))).toBe('<b>true</b>')
  })
})
