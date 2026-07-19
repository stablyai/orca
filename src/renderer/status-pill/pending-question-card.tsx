import {
  parseAskFromStatus,
  formatAskAnswer,
  type AskAnswerSelection
} from '../../shared/native-chat-ask'
import type { StatusPillPendingQuestion } from '../../shared/status-pill-preload-api'

type AskPrompt = NonNullable<ReturnType<typeof parseAskFromStatus>>

type ParsedPrompt =
  | { kind: 'question'; questions: AskPrompt['questions'] }
  | { kind: 'approval'; tool: string; summary: string }

/** Parse the interactivePrompt envelope into either a structured AskUserQuestion
 *  card or an approval card. Returns null when the envelope is malformed or
 *  empty. */
export function parsePendingPrompt(
  interactivePrompt: string,
  toolName?: string
): ParsedPrompt | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  // Why: approval envelope `{ approval: { tool, summary } }` is the format the
  // main-window native-chat renderer uses for PermissionRequest events. We
  // mirror the same shape here so the pill renders the same card.
  const approval = (parsed as { approval?: { tool?: unknown; summary?: unknown } }).approval
  if (approval && typeof approval === 'object') {
    const tool = typeof approval.tool === 'string' ? approval.tool : 'tool'
    const summary = typeof approval.summary === 'string' ? approval.summary : ''
    return { kind: 'approval', tool, summary }
  }
  // Why: fall back to the shared AskUserQuestion parser so opencode, Claude,
  // Codex, Grok, etc. all share one path. Returns null if the envelope is not
  // a valid questions shape.
  const ask = parseAskFromStatus(interactivePrompt, toolName)
  if (ask && ask.questions.length > 0) {
    return { kind: 'question', questions: ask.questions }
  }
  return null
}

export function PendingQuestionCard({
  pending,
  onAnswer,
  submitting,
  error
}: {
  pending: StatusPillPendingQuestion
  onAnswer: (paneKey: string, raw: string) => Promise<void>
  submitting: boolean
  error: string | null
}): React.JSX.Element | null {
  const parsed = parsePendingPrompt(pending.interactivePrompt, pending.toolName)
  if (!parsed) {
    // Why: if the envelope is malformed, fall back to a generic single-action
    // card that opens the main window. The user still gets notified.
    return (
      <div className="perm-card">
        <div className="perm-path">
          <span>{pending.agentLabel} needs a decision</span>
        </div>
        <div className="perm-actions">
          <button type="button" className="btn btn-allow" onClick={() => window.api?.fireClick()}>
            Open Orca
          </button>
        </div>
      </div>
    )
  }
  if (parsed.kind === 'approval') {
    return (
      <ApprovalCardView
        paneKey={pending.paneKey}
        agentLabel={pending.agentLabel}
        tool={parsed.tool}
        summary={parsed.summary}
        onAnswer={onAnswer}
        submitting={submitting}
        error={error}
      />
    )
  }
  return (
    <QuestionCardView
      paneKey={pending.paneKey}
      agentLabel={pending.agentLabel}
      questions={parsed.questions}
      onAnswer={onAnswer}
      submitting={submitting}
      error={error}
    />
  )
}

function QuestionCardView({
  paneKey,
  agentLabel,
  questions,
  onAnswer,
  submitting,
  error
}: {
  paneKey: string
  agentLabel: string
  questions: AskPrompt['questions']
  onAnswer: (paneKey: string, raw: string) => Promise<void>
  submitting: boolean
  error: string | null
}): React.JSX.Element {
  // Why: V2 multi-question / multi-select is rare and adds UX complexity; the
  // first question's first-pick is by far the most common opencode case
  // ("Which deployment target?"). Render only the first question's options,
  // each as a discrete button. Multi-question support lands in V3 if needed.
  const question = questions[0]
  if (!question) {
    return null
  }
  const handlePick = (index: number): void => {
    if (submitting) {
      return
    }
    const selections: AskAnswerSelection[] = questions.map((_, qi) => ({
      indices: qi === 0 ? [index] : [],
      other: ''
    }))
    const text = formatAskAnswer({ questions }, selections)
    // Why: append Enter so the agent commits the pasted answer. The main
    // window's sendNativeChatMessage path does the same.
    void onAnswer(paneKey, `${text}\n`)
  }
  return (
    <div className="perm-card">
      <div className="perm-path">
        <span className="perm-agent">{agentLabel} asks</span>
      </div>
      <div className="perm-question">{question.question}</div>
      {question.options.length > 0 ? (
        <div className="perm-options">
          {question.options.map((option, index) => (
            <button
              key={`${option.label}-${index}`}
              type="button"
              className="btn btn-option"
              disabled={submitting}
              onClick={() => handlePick(index)}
            >
              <span className="kbd">{index + 1}</span>
              <span className="btn-label">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <div className="perm-error">{formatAnswerError(error)}</div> : null}
    </div>
  )
}

function ApprovalCardView({
  paneKey,
  agentLabel,
  tool,
  summary,
  onAnswer,
  submitting,
  error
}: {
  paneKey: string
  agentLabel: string
  tool: string
  summary: string
  onAnswer: (paneKey: string, raw: string) => Promise<void>
  submitting: boolean
  error: string | null
}): React.JSX.Element {
  const allow = (): void => {
    if (submitting) {
      return
    }
    // Why: '1' is the literal keystroke Claude/Codex/Copilot use to commit
    // the first option of their permission TUI. The main window uses the
    // same byte via NativeChatApprovalCard.
    void onAnswer(paneKey, '1')
  }
  const deny = (): void => {
    if (submitting) {
      return
    }
    // Why: ESC cancels every supported agent's permission TUI.
    void onAnswer(paneKey, '\x1b')
  }
  return (
    <div className="perm-card">
      <div className="perm-path">
        <span className="perm-agent">{agentLabel}</span>
        <span className="perm-tool"> · {tool}</span>
      </div>
      {summary ? <pre className="perm-summary">{summary}</pre> : null}
      <div className="perm-actions">
        <button type="button" className="btn btn-deny" disabled={submitting} onClick={deny}>
          Deny <span className="kbd">Esc</span>
        </button>
        <button
          type="button"
          className="btn btn-allow-always"
          disabled={submitting}
          onClick={allow}
        >
          Allow <span className="kbd">1</span>
        </button>
      </div>
      {error ? <div className="perm-error">{formatAnswerError(error)}</div> : null}
    </div>
  )
}

function formatAnswerError(error: string): string {
  switch (error) {
    case 'pane_not_found':
      return 'Pane no longer available — the agent may have moved on.'
    case 'terminal_not_writable':
      return 'Terminal is not writable. Try answering from the Orca main window.'
    case 'send_failed':
      return 'Could not deliver the answer. Try again.'
    default:
      return 'Something went wrong.'
  }
}
