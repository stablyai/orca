import type { BotTemplate } from '../bot-templates'

export const BOT_TEMPLATES_RELEASES: readonly BotTemplate[] = [
  {
    id: 'release',
    category: 'releases',
    name: 'Release readiness',
    line: 'Tracks what’s blocking the next release.',
    firstChat:
      'Keeps a short readiness list: failing checks, pull requests waiting for review, open blockers.',
    mascot: 'D1',
    watches: 'Pull requests, checks and workspaces',
    does: 'Keeps a short readiness list: failing checks, pull requests waiting for review, open blockers.',
    reports: 'Here, weekday mornings',
    connectors: ['github'],
    schedules: [
      {
        id: 'readiness-list',
        when: 'Weekdays at 9 AM',
        what: 'Readiness list',
        rrule: '0 9 * * 1-5',
        prompt:
          'Update the release readiness list with the release-readiness skill: failing checks, pull requests waiting for review, open blockers. Lead with blocked or ready.'
      }
    ],
    events: [],
    skills: ['release-readiness'],
    example: [
      '1.5 is blocked by one failing check: typecheck on #4121.',
      'Two pull requests still need a review: #4108, #4130.'
    ]
  },
  {
    id: 'release-notes',
    category: 'releases',
    name: 'Release notes',
    line: 'Drafts the next release’s notes from merged pull requests.',
    firstChat:
      'Finds the last release tag and drafts notes in three groups: new, fixed, changed. You edit them here.',
    mascot: 'E1',
    watches: 'Pull requests merged since the last release',
    does: 'Drafts release notes for users in three groups: new, fixed, changed.',
    reports: 'Here, when you ask',
    connectors: ['github'],
    schedules: [],
    events: [],
    skills: ['release-notes-style'],
    example: ['Draft for 1.5: 4 new, 9 fixed, 2 changed.', 'Biggest change: bots can share skills.']
  },
  {
    id: 'ci-failures',
    category: 'releases',
    name: 'CI failures',
    line: 'Explains failed checks and keeps a list of flaky ones.',
    firstChat:
      'Reads the last two weeks of check runs and lists the flaky ones, then explains each failing check on your open pull requests. It starts a fix only after you agree.',
    mascot: 'G1',
    watches: 'Check runs in the repos you pick',
    does: 'Tells flaky checks from real failures, explains each failure, and keeps a list of flaky checks.',
    reports: 'Here, Mondays at 9 AM and when a check fails',
    connectors: ['github'],
    schedules: [
      {
        id: 'flaky-list',
        when: 'Mondays at 9 AM',
        what: 'Flaky checks',
        rrule: '0 9 * * 1',
        prompt:
          'Read the last week of check runs in the repos my owner picked and update the list of flaky checks with the ci-failure-triage skill, worst first.'
      }
    ],
    events: [
      {
        id: 'check-failed',
        name: 'When a check fails: say whether it’s flaky or real',
        source: 'github',
        event: 'ci_failed',
        prompt:
          'A check failed. If it isn’t on a branch my owner cares about, stop without posting. Otherwise sort it with the ci-failure-triage skill and post whether it is real, flaky or infrastructure, with the cause.'
      }
    ],
    skills: ['ci-failure-triage'],
    needsSetup:
      'GitHub can’t filter failures by branch yet, so the bot looks at every failure in the repo and skips the ones that don’t matter. Each one costs a turn.',
    example: [
      '#4130 typecheck: a renamed export, two call sites missed. Fix is one commit.',
      'Flakiest this week: terminal-resize test, 4 of 30 runs.'
    ]
  },
  {
    id: 'deploy-watch',
    category: 'releases',
    name: 'Deploy watch',
    line: 'Posts what changed in each deploy and flags failed ones.',
    firstChat:
      'Gives you an automation address for your deploy tool to call, then summarizes each deploy from the pull requests it shipped.',
    mascot: 'I1',
    watches: 'Calls from your deploy tool',
    does: 'Summarizes each deploy from the pull requests it shipped, and flags failed ones.',
    reports: 'Here, after each deploy',
    connectors: ['github'],
    schedules: [],
    events: [
      {
        id: 'deploy-called',
        name: 'When your deploy tool calls: summarize the deploy',
        source: 'webhook',
        event: 'call',
        prompt:
          'The deploy tool called. Read what it sent, find the pull requests this deploy shipped, and post a short summary here. Lead with a failure if it failed.'
      }
    ],
    skills: [],
    needsSetup:
      'No deploy-tool connector: you add the automation’s address to your deploy tool by hand.',
    example: [
      'Production deploy 14:02: 5 pull requests, including the relay retry fix.',
      'Staging deploy failed at migrate: column already exists.'
    ]
  }
]
