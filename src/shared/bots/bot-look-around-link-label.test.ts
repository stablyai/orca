import { describe, expect, it } from 'vitest'
import { suggestionLinkLabel } from './bot-look-around'

describe('suggestion link labels', () => {
  it.each([
    ['https://github.com/stablyai/orca/pull/1234', 'orca#1234'],
    ['https://github.com/stablyai/orca/issues/88#issuecomment-1', 'orca#88'],
    ['https://github.com/stablyai/orca/actions/runs/1234567', 'orca'],
    ['https://linear.app/globex/issue/ENG-3110/bot-replies-drop-images', 'ENG-3110'],
    ['https://globex.slack.com/archives/C0ENG/p1793390000000100', 'globex.slack.com'],
    ['https://www.example.com/x', 'example.com'],
    ['not a url', 'not a url']
  ])('%s reads as %s', (link, label) => {
    expect(suggestionLinkLabel(link)).toBe(label)
  })
})
