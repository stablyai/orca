// Question-tool results with the exact structure and key sets of records the agents
// wrote, with every question, option, answer, id and path replaced by synthetic text.

/** Two questions, the second multi-select, recorded as a list (Claude Code 2.1.261). */
export const CLAUDE_RECORDED_MULTI_SELECT_LIST = {
  questions: [
    {
      question: 'Which storage for the cache?',
      header: 'Storage',
      options: [
        { label: 'On disk', description: 'Survives a restart of the app.' },
        { label: 'Memory', description: 'Fast, and lost on every restart.' }
      ],
      multiSelect: false
    },
    {
      question: 'Which checks run?',
      header: 'Checks',
      options: [
        { label: 'Lint', description: 'Style rules only.' },
        { label: 'Tests', description: 'Unit and e2e suites.' }
      ],
      multiSelect: true
    }
  ],
  answers: {
    'Which storage for the cache?': 'On disk',
    'Which checks run?': ['Lint', 'Tests']
  }
}

/** One question answered with typed text in place of an option (Claude Code 2.1.280). */
export const CLAUDE_RECORDED_TYPED_ANSWER = {
  questions: [
    {
      question: 'How should the importer treat duplicate rows?',
      header: 'Dupes',
      options: [
        { label: 'Keep the newest row', description: 'Later rows replace earlier ones.' },
        { label: 'Keep the first row', description: 'Later rows are skipped.' },
        { label: 'Stop the import', description: 'Fail on the first duplicate.' },
        { label: 'Ask each time', description: 'Prompt per duplicate.' }
      ],
      multiSelect: false
    }
  ],
  answers: { 'How should the importer treat duplicate rows?': 'Merge them, "newest" wins' },
  annotations: {}
}

/** Two questions, the first with option previews, which the result echoes (Claude Code 2.1.261). */
export const CLAUDE_RECORDED_PREVIEW_ANSWER = {
  questions: [
    {
      question: 'Which layout for the header?',
      header: 'Layout',
      options: [
        { label: 'Stacked', description: 'Title above actions.', preview: '[Title]\n[Actions]' },
        { label: 'Inline', description: 'Title beside actions.', preview: '[Title] [Actions]' },
        { label: 'Hidden', description: 'No header at all.', preview: '(none)' }
      ],
      multiSelect: false
    },
    {
      question: 'Ship it behind a flag?',
      header: 'Flag',
      options: [
        { label: 'Yes', description: 'Off by default.' },
        { label: 'No', description: 'On for everyone.' }
      ],
      multiSelect: false
    }
  ],
  answers: { 'Which layout for the header?': 'Stacked', 'Ship it behind a flag?': 'Yes' },
  annotations: { 'Which layout for the header?': { preview: '[Title]\n[Actions]' } }
}

/** What the model reads when the reader rejects the prompt: Claude Code's own text. */
export const CLAUDE_DECLINED_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
/** The two `toolUseResult` strings recorded for a rejected prompt. */
export const CLAUDE_DECLINED_RESULTS = [
  'User rejected tool use',
  "Error: The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nnot now"
]

/** A one-question `request_user_input` call and its answered output (Codex rollout). */
export const CODEX_RECORDED_CALL_ARGUMENTS = JSON.stringify({
  questions: [
    {
      header: 'Scope',
      id: 'fix_scope',
      options: [
        { label: 'Only the parser', description: 'Leave the callers unchanged.' },
        { label: 'Both', description: 'Change the parser and callers.' }
      ],
      question: 'How wide should the fix go this time?'
    }
  ]
})
export const CODEX_RECORDED_OUTPUT = JSON.stringify({
  answers: { fix_scope: { answers: ['Only the parser'] } }
})
/** The plain-text outputs Codex recorded when it refused or the reader aborted. */
export const CODEX_RECORDED_PLAIN_OUTPUTS = [
  'request_user_input is unavailable in Default mode',
  'request_user_input can only be used by the root thread',
  'aborted by user after 4.1s'
]
