import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The cards a bot offers with `--offer`; a source check that they answer through one owner, not proof of behaviour.
const offerCards = [
  'native-chat/NativeChatConnectorOfferCard.tsx',
  'native-chat/NativeChatBotCreateOfferCard.tsx',
  'native-chat/NativeChatImportPlanCard.tsx'
]

const components = join(__dirname, '..')

function source(file: string): string {
  return readFileSync(join(components, file), 'utf8')
}

describe('offer cards share one lifecycle', () => {
  it('only the shared actions read a card’s answer, so a new card cannot keep its own rule', () => {
    const readsReplies = readdirSync(components, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.|fixture/.test(file))
      .filter((file) => source(file).includes('offerAnswer'))
      .map((file) => relative(components, join(components, file)).replaceAll('\\', '/'))
    expect(readsReplies).toEqual(['native-chat/NativeChatOfferActions.tsx'])
  })

  it.each(offerCards)('%s answers through NativeChatOfferActions', (file) => {
    const text = source(file)
    expect(text).toContain('useNativeChatOffer(')
    expect(text).toContain('<NativeChatOfferActions')
    expect(text).not.toContain('NativeChatBotKickoffContext')
    expect(text).not.toMatch(/'Dismiss'/)
  })
})
