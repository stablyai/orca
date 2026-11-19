import type { BotTemplate } from '../bot-templates'

export const BOT_TEMPLATES_OPS: readonly BotTemplate[] = [
  {
    id: 'incident-notes',
    category: 'ops',
    name: 'Incident notes',
    line: 'Keeps a timeline in an incident channel and drafts the write-up.',
    firstChat:
      'Follows the incident channel you pick and its threads, keeps a timestamped timeline, and drafts a blameless write-up when it’s over.',
    mascot: 'H2',
    watches: 'The incident channel you pick, and its threads',
    does: 'Keep a timestamped timeline, then draft a blameless write-up.',
    reports: 'Here, during and after an incident',
    connectors: ['slack'],
    schedules: [],
    events: [
      {
        id: 'incident-posted',
        name: 'When someone posts in an incident channel: add it to the timeline',
        source: 'slack',
        event: 'message',
        prompt:
          'Someone posted in the incident channel. Add what matters to the timeline with the incident-timeline skill, and read the thread it starts too. Post only when the timeline changes.'
      }
    ],
    skills: ['incident-timeline'],
    example: [
      '14:02 alert fired; 14:09 rollback started; 14:21 errors back to normal.',
      'Write-up draft ready.'
    ]
  },
  {
    id: 'oncall-handoff',
    category: 'ops',
    name: 'On-call handoff',
    line: 'A weekly summary of alerts, incidents and open follow-ups.',
    firstChat:
      'Reads your alert channel and incident issues from the past week and writes the handoff.',
    mascot: 'B1',
    watches: 'Your alert channel and incident issues',
    does: 'Summarize the week’s alerts and incidents, and list open follow-ups.',
    reports: 'Here, Fridays at 4 PM',
    connectors: ['slack', 'linear'],
    schedules: [
      {
        id: 'weekly-handoff',
        when: 'Fridays at 4 PM',
        what: 'Handoff',
        rrule: '0 16 * * 5',
        prompt:
          'Write the on-call handoff for the past week: alerts by count, incidents with a one-line summary each, and open follow-ups with owners.'
      }
    ],
    events: [],
    skills: ['incident-timeline'],
    needsSetup: 'No paging-tool connector: it reads alerts only where they’re posted in Slack.',
    example: [
      '12 alerts, 2 incidents. Disk alert on cell-3 fired 5 times.',
      '3 follow-ups still open.'
    ]
  }
]

export const BOT_TEMPLATES_PERSONAL: readonly BotTemplate[] = [
  {
    id: 'followup',
    category: 'personal',
    name: 'Replies you owe',
    line: 'Reminds you of replies you still owe.',
    firstChat:
      'Finds questions to you with no reply, and things you said you’d do, in Slack threads and issue comments.',
    mascot: 'E1',
    watches: 'Slack threads and Linear comments',
    does: 'Find questions to you with no reply, and things you said you’d do.',
    reports: 'Here, daily at 4 PM',
    connectors: ['slack', 'linear'],
    schedules: [
      {
        id: 'daily-owed',
        when: 'Daily at 4 PM',
        what: 'What you still owe',
        rrule: '0 16 * * *',
        prompt:
          'Find questions to my owner with no reply, and things my owner said they’d do, in Slack threads and Linear comments. Oldest first, with links.'
      }
    ],
    events: [],
    skills: [],
    example: [
      'You told a teammate “I’ll check tomorrow” in #design, 2 days ago.',
      'ORC-881 has a question for you from yesterday.'
    ]
  },
  {
    id: 'standup',
    category: 'personal',
    name: 'Daily standup notes',
    line: 'What you and your agents did yesterday, and what’s next.',
    firstChat:
      'Writes yesterday’s notes from your workspaces, merged pull requests and moved issues. You copy them where your team reads them.',
    mascot: 'O1',
    watches: 'Your workspaces, pull requests and issues',
    does: 'Write yesterday’s notes and today’s plan.',
    reports: 'Here, weekdays at 9 AM',
    connectors: ['github', 'linear'],
    schedules: [
      {
        id: 'daily-notes',
        when: 'Weekdays at 9 AM',
        what: 'Standup notes',
        rrule: '0 9 * * 1-5',
        prompt:
          'Write my owner’s standup notes with the status-brief skill: what they and their agents did yesterday (workspaces, merged pull requests, moved issues) and what is next.'
      }
    ],
    events: [],
    skills: ['status-brief'],
    example: [
      'Yesterday: merged #4121, relay retry. Agents finished 2 workspaces.',
      'Today: ORC-702, review #4130.'
    ]
  },
  {
    id: 'email-digest',
    category: 'personal',
    name: 'Email digest',
    line: 'Twice a day, the emails that need a reply from you.',
    firstChat:
      'Reads today’s inbox and lists emails that need your reply, newest first. It never sends email.',
    mascot: 'I1',
    watches: 'Your inbox',
    does: 'List emails that need a reply from my owner, newest first. Never send email.',
    reports: 'Here, weekdays at 9 AM and 2 PM',
    connectors: ['google'],
    schedules: [
      {
        id: 'morning',
        when: 'Weekdays at 9 AM',
        what: 'Emails that need you',
        rrule: '0 9 * * 1-5',
        prompt:
          'List emails since yesterday afternoon that need a reply from my owner, newest first, one line each. Skip newsletters and notifications. Never send email.'
      },
      {
        id: 'afternoon',
        when: 'Weekdays at 2 PM',
        what: 'Emails that need you',
        rrule: '0 14 * * 1-5',
        prompt:
          'List emails since this morning that need a reply from my owner, newest first, one line each. Skip newsletters and notifications. Never send email.'
      }
    ],
    events: [],
    skills: [],
    example: [
      '2 need a reply: the security review date, and an invoice question.',
      '14 newsletters skipped.'
    ]
  },
  {
    id: 'meeting-prep',
    category: 'personal',
    name: 'Meeting prep',
    line: 'Before each meeting, the issues, pull requests and docs it’s about.',
    firstChat: 'Looks at today’s calendar and writes a short prep note for each meeting.',
    mascot: 'S2',
    watches: 'Your calendar',
    does: 'Before each meeting, list the issues, pull requests and docs it is about.',
    reports: 'Here, before each meeting',
    connectors: ['google', 'github', 'linear'],
    schedules: [],
    events: [
      {
        id: 'meeting-soon',
        name: '15 minutes before a meeting: prep note',
        source: 'calendar',
        event: 'starting_soon',
        prompt:
          'A meeting starts in 15 minutes. Write a short prep note: who is in it, and the issues, pull requests and docs it is about, with links.'
      }
    ],
    skills: [],
    example: [
      'Mobile sync at 11: ORC-902 needs a decision; #4130 is waiting on you.',
      'Doc: “Push permission copy”.'
    ]
  }
]
