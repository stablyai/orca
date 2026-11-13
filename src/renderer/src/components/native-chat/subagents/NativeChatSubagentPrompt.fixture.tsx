import { defineFixture } from '../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatSubagentPrompt } from './NativeChatSubagentPrompt'

const short = 'List the files in `src/` and read `src/math.ts`. Report what it exports.'

const long = [
  'Audit the auth flow for token refresh bugs.',
  '',
  '1. Read `src/auth/session.ts` and `src/auth/refresh.ts`.',
  '2. Find every place a request retries after a **401**.',
  '3. Check whether two refreshes can run at once.',
  '4. Note any timer that refreshes before expiry.',
  '5. Look for tests that cover a refresh race.',
  '6. Do not change any files.',
  '7. Reply with a short list of findings, most serious first.',
  '8. Include file paths and line numbers for each finding.'
].join('\n')

function Prompt({ prompt }: { prompt: string }) {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatSubagentPrompt agentId="a1" prompt={prompt} />
    </div>
  )
}

export const brief = defineFixture({ width: 640, render: () => <Prompt prompt={short} /> })

export const folded = defineFixture({ width: 640, render: () => <Prompt prompt={long} /> })
