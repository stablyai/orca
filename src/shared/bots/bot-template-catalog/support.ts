import type { BotTemplate } from '../bot-templates'

export const BOT_TEMPLATES_SUPPORT: readonly BotTemplate[] = [
  {
    id: 'support',
    category: 'support',
    name: 'Support triage',
    line: 'Keeps a list of questions nobody has answered.',
    firstChat:
      'Lists unanswered questions in the Slack channels you pick, with links, and notes which already have an issue.',
    mascot: 'A1',
    watches: 'Slack channels you pick',
    does: 'List unanswered questions with links. Note which already have a Linear issue.',
    reports: 'Here, every 2 hours on weekdays',
    connectors: ['slack', 'linear'],
    schedules: [
      {
        id: 'unanswered',
        when: 'Weekdays, every 2 hours from 9 AM to 5 PM',
        short: 'Every 2 hours',
        what: 'Unanswered questions',
        rrule: '0 9-17/2 * * 1-5',
        prompt:
          'List new questions nobody has answered in the Slack channels my owner picked, oldest first, with links. Note which already have an issue.'
      }
    ],
    events: [],
    skills: ['issue-triage'],
    example: [
      '3 new questions in #help since 11 AM. Oldest: SSH remote keeps disconnecting, 2 hours.',
      '“Can I export a bot?” already has SUP-212.'
    ]
  },
  {
    id: 'feedback',
    category: 'support',
    name: 'Feedback digest',
    line: 'Turns feedback into a weekly list of themes.',
    firstChat:
      'Groups the last month of feedback in the channels you pick into themes, with counts and quotes.',
    mascot: 'F1',
    watches: 'Slack feedback channels',
    does: 'Group feedback into themes with quotes and counts. Link existing Linear issues.',
    reports: 'Here, Mondays at 9 AM',
    connectors: ['slack', 'linear'],
    schedules: [
      {
        id: 'weekly-themes',
        when: 'Mondays at 9 AM',
        short: 'Mon 9 AM',
        what: 'Themes of the week',
        rrule: '0 9 * * 1',
        prompt:
          'Group last week’s feedback in the channels my owner picked into themes with the feedback-themes skill, biggest first.'
      }
    ],
    events: [],
    skills: ['feedback-themes'],
    example: [
      'Top theme: pasting in the Windows terminal, 7 people, linked ORC-640.',
      'New this week: 3 people asked to export a bot.'
    ]
  },
  {
    id: 'bug-intake',
    category: 'support',
    name: 'Bug report intake',
    line: 'Turns bug reports in Slack into tracked issues with repro steps.',
    firstChat:
      'Reads the channel you pick and drafts an issue for each new bug report. It files them only after you approve.',
    mascot: 'Q1',
    watches: 'The Slack channel where bugs are reported',
    does: 'Draft a Linear issue with repro steps for each bug report; file it once approved.',
    reports: 'Here, when a bug is reported',
    connectors: ['slack', 'linear'],
    schedules: [],
    events: [
      {
        id: 'bug-posted',
        name: 'When someone posts in your bugs channel: draft an issue',
        source: 'slack',
        event: 'message',
        prompt:
          'Someone posted in the bugs channel. If it reports a bug, draft an issue with the issue-triage skill: title, steps, expected and actual result, and any likely duplicate. Post the draft here; file it only after my owner approves.'
      }
    ],
    skills: ['issue-triage'],
    example: [
      'Drafted: “Terminal freezes after sleep on macOS 27”, steps from the thread.',
      'Possible duplicate of ORC-702.'
    ]
  },
  {
    id: 'issue-triage',
    category: 'support',
    name: 'GitHub issue triage',
    line: 'Labels new issues, finds duplicates and asks for missing details.',
    firstChat:
      'Goes through the last week of new issues in a repo you pick and proposes labels and duplicates here.',
    mascot: 'R3',
    watches: 'New issues in the repos you pick',
    does: 'Propose labels and duplicates, and list missing details, for each new issue.',
    reports: 'Here, when an issue is opened',
    connectors: ['github'],
    schedules: [],
    events: [
      {
        id: 'issue-opened',
        name: 'When an issue is opened: propose labels and duplicates',
        source: 'github',
        event: 'issue_opened',
        prompt:
          'An issue was opened. Triage it with the issue-triage skill and post the proposed labels, likely duplicate and missing details here. Change nothing on GitHub unless my owner said I can.'
      }
    ],
    skills: ['issue-triage'],
    example: [
      '#2210: bug, windows, duplicate of #2188.',
      '#2214 has no version or steps. Ask for them?'
    ]
  }
]
