import { translate } from '@/i18n/i18n'

export type SessionSearchDemoRow = {
  agent: 'claude' | 'codex'
  title: string
  role: string
  /** Hit snippets use the index's [[match]] markers so the demo highlights like real results. */
  text: string
  messages: number
  age: string
}

export type SessionSearchDemoScene = { query: string; hits: SessionSearchDemoRow[] }

function assistantRole(): string {
  return translate('featureTips.sessionSearch.demoRoleAssistant', 'Assistant')
}

function userRole(): string {
  return translate('featureTips.sessionSearch.demoRoleUser', 'User')
}

/** What the panel lists before anything is typed. */
export function getSessionSearchDemoRecentRows(): SessionSearchDemoRow[] {
  return [
    {
      agent: 'claude',
      title: translate('featureTips.sessionSearch.recent1Title', 'Tidy the settings sidebar'),
      role: assistantRole(),
      text: translate(
        'featureTips.sessionSearch.recent1Text',
        'Moved the search entries under Workflows and updated the tests.'
      ),
      messages: 42,
      age: translate('featureTips.sessionSearch.ageMinutes', '12m')
    },
    {
      agent: 'codex',
      title: translate('featureTips.sessionSearch.recent2Title', 'Bump the lockfile'),
      role: userRole(),
      text: translate(
        'featureTips.sessionSearch.recent2Text',
        'Update the dependencies and make sure the build still passes.'
      ),
      messages: 18,
      age: translate('featureTips.sessionSearch.ageHours', '2h')
    },
    {
      agent: 'claude',
      title: translate('featureTips.sessionSearch.recent3Title', 'Release notes draft'),
      role: assistantRole(),
      text: translate(
        'featureTips.sessionSearch.recent3Text',
        'Here is a first pass at the notes, grouped by area.'
      ),
      messages: 9,
      age: translate('featureTips.sessionSearch.ageYesterday', '1d')
    }
  ]
}

export function getSessionSearchDemoScenes(): SessionSearchDemoScene[] {
  return [
    {
      query: translate('featureTips.sessionSearch.demoQuery', 'login timeout'),
      hits: [
        {
          agent: 'claude',
          title: translate('featureTips.sessionSearch.demoHit1Title', 'Fix flaky auth redirect'),
          role: assistantRole(),
          text: translate(
            'featureTips.sessionSearch.demoHit1Snippet',
            'Raised the [[login timeout]] to 30s and added a retry on the token refresh.'
          ),
          messages: 64,
          age: translate('featureTips.sessionSearch.demoHit1Age', '3d')
        },
        {
          agent: 'codex',
          title: translate(
            'featureTips.sessionSearch.demoHit2Title',
            'Session refresh after sleep'
          ),
          role: userRole(),
          text: translate(
            'featureTips.sessionSearch.demoHit2Snippet',
            'Why does the [[login]] page hang after a [[timeout]] on wake?'
          ),
          messages: 27,
          age: translate('featureTips.sessionSearch.demoHit2Age', '1w')
        },
        {
          agent: 'claude',
          title: translate('featureTips.sessionSearch.demoHit3Title', 'Auth e2e hardening'),
          role: assistantRole(),
          text: translate(
            'featureTips.sessionSearch.demoHit3Snippet',
            'Added a test that covers the [[login timeout]] path end to end.'
          ),
          messages: 31,
          age: translate('featureTips.sessionSearch.demoHit3Age', '2w')
        }
      ]
    },
    {
      query: translate('featureTips.sessionSearch.demoQuery2', 'migration rollback'),
      hits: [
        {
          agent: 'codex',
          title: translate('featureTips.sessionSearch.demoHit4Title', 'Orders table migration'),
          role: assistantRole(),
          text: translate(
            'featureTips.sessionSearch.demoHit4Snippet',
            'The [[rollback]] drops the new index first, then restores the old column.'
          ),
          messages: 53,
          age: translate('featureTips.sessionSearch.demoHit4Age', '5d')
        },
        {
          agent: 'claude',
          title: translate('featureTips.sessionSearch.demoHit5Title', 'Staging deploy failed'),
          role: userRole(),
          text: translate(
            'featureTips.sessionSearch.demoHit5Snippet',
            'Can you write a [[migration]] [[rollback]] plan before we retry?'
          ),
          messages: 22,
          age: translate('featureTips.sessionSearch.demoHit5Age', '3w')
        },
        {
          agent: 'claude',
          title: translate('featureTips.sessionSearch.demoHit6Title', 'Schema review notes'),
          role: assistantRole(),
          text: translate(
            'featureTips.sessionSearch.demoHit6Snippet',
            'Every [[migration]] here is reversible except the enum rename.'
          ),
          messages: 14,
          age: translate('featureTips.sessionSearch.demoHit6Age', '1mo')
        }
      ]
    }
  ]
}
