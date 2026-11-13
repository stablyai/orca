// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { RecipeEnvForwardingWarning } from './RecipeEnvForwardingWarning'

afterEach(cleanup)

const summary = { count: 2, keyLike: ['AWS_SECRET_ACCESS_KEY'], other: ['PATH'] }

it('says the recipe gets only what its passEnv allows, with passEnv as code', () => {
  render(<RecipeEnvForwardingWarning summary={{ ...summary, narrowed: true }} />)
  const code = screen.getByText('passEnv')
  expect(code.tagName).toBe('CODE')
  expect(code.parentElement?.textContent).toBe(
    "This recipe's create script gets only the variables its passEnv allows."
  )
  expect(screen.queryByText(/this computer's environment/)).toBeNull()
})

it("keeps the whole-environment headline when passEnv didn't apply", () => {
  render(<RecipeEnvForwardingWarning summary={{ ...summary, narrowed: false }} />)
  expect(
    screen.getByText("This recipe's create script gets this computer's environment.")
  ).toBeTruthy()
})
