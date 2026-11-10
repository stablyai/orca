import { defineFixture } from '../../component-fixtures/component-fixture'
import { RecipeEnvForwardingWarning } from './RecipeEnvForwardingWarning'

const summary = {
  count: 42,
  keyLike: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN'],
  other: ['EDITOR', 'HOME', 'LANG', 'PATH', 'SHELL', 'TERM', 'USER']
}

export const warning = defineFixture({
  width: 420,
  render: () => <RecipeEnvForwardingWarning summary={summary} />
})

export const review = defineFixture({
  width: 420,
  render: () => <RecipeEnvForwardingWarning summary={summary} defaultReviewOpen />
})

export const manyKeys = defineFixture({
  width: 420,
  render: () => (
    <RecipeEnvForwardingWarning
      summary={{
        ...summary,
        keyLike: ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN']
      }}
    />
  )
})

export const noKeys = defineFixture({
  width: 420,
  render: () => <RecipeEnvForwardingWarning summary={{ ...summary, keyLike: [] }} />
})

export const loading = defineFixture({
  width: 420,
  render: () => <RecipeEnvForwardingWarning summary={null} />
})

export const unavailable = defineFixture({
  width: 420,
  render: () => <RecipeEnvForwardingWarning summary={undefined} />
})
