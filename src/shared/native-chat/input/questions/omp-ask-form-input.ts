import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from '../../../agent-status/contracts/agent-status-types'
import { BoundedMap } from '../../../collections/bounded-map'
import type { AskOption, AskPrompt, AskQuestion } from './native-chat-ask-types'
import {
  formDescendants,
  formHtmlWithoutMedia,
  formPlainText,
  readFormMarkup
} from './omp-ask-form-markup'
import { OmpAskFormReader, type FormSection } from './omp-ask-form-sections'

/** OMP's question tool: OMP 18.18.3+ sends one HTML form (`{ html }`), older versions `questions[]`. */
export const OMP_ASK_TOOL = 'ask'

/**
 * Each named field's question as OMP words it: its own label, else the text block right before it,
 * else its fieldset legend, else a lone option's label, else its name. Disabled options drop.
 */
function formQuestions(sections: readonly FormSection[]): AskQuestion[] {
  const questions: AskQuestion[] = []
  for (const section of sections) {
    let caption = ''
    for (const block of section.blocks) {
      if (block.kind !== 'field') {
        caption = block.kind === 'text' ? block.text : ''
        continue
      }
      const { field } = block
      const lone =
        field.kind === 'choice' && field.options.length === 1 ? field.options[0]!.label : ''
      const question = field.label || caption || section.title || lone || formPlainText(field.name)
      caption = ''
      if (!field.name) {
        continue
      }
      // What OMP's terminal preselects (`checked`/`selected`, a single select's first option) reads as recommended.
      const options = field.options.flatMap((option): AskOption[] => {
        const label = option.label || option.value
        return option.disabled ? [] : [{ label, ...(option.checked ? { recommended: true } : {}) }]
      })
      questions.push({
        question,
        multiSelect: field.multi,
        options,
        ...(field.required ? { required: true } : {})
      })
    }
  }
  return questions
}

// Bounds hostile input to what live status can carry once inline media is emptied; agent forms are a few KB.
const MAX_FORM_HTML = AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
// The agent writes the form as tool output, so even one with an inline image is far smaller.
const MAX_FORM_SOURCE = 256_000
// Fresh status and snapshot objects miss `promptsByInput`; 256 forms at the status cap fit here.
const promptsByHtml = new BoundedMap<string, AskPrompt | null>({
  maxEntries: 1_024,
  maxBytes: 256 * MAX_FORM_HTML,
  maxEntryBytes: MAX_FORM_HTML,
  sizeOf: (_, html) => html.length
})
// Transcript rows keep their inputs across pending-ask scans, however many asks they hold.
const promptsByInput = new WeakMap<object, { html: string; prompt: AskPrompt | null }>()

function readForm(html: string): AskPrompt | null {
  const read = promptsByHtml.get(html)
  if (read !== undefined) {
    return read
  }
  const document = readFormMarkup(
    formHtmlWithoutMedia(html.slice(0, MAX_FORM_SOURCE), MAX_FORM_HTML)
  )
  // Like OMP, only the first `<form>` counts when there is one.
  const form = formDescendants(document, (element) => element.tag === 'form')[0] ?? document
  const questions = formQuestions(new OmpAskFormReader(form).sections)
  const prompt = questions.length > 0 ? { questions } : null
  promptsByHtml.set(html, prompt)
  return prompt
}

export function isOmpAskFormInput(input: unknown): input is { html: string } {
  return !!input && typeof input === 'object' && 'html' in input && typeof input.html === 'string'
}

/** Questions of OMP's HTML-form `ask` input; null for any other shape, which falls back to `questions[]`. */
export function parseOmpAskFormInput(input: unknown): AskPrompt | null {
  if (!isOmpAskFormInput(input)) {
    return null
  }
  const { html } = input
  const read = promptsByInput.get(input)
  if (read?.html === html) {
    return read.prompt
  }
  const prompt = readForm(html)
  promptsByInput.set(input, { html, prompt })
  return prompt
}
