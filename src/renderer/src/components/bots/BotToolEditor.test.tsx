// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotToolEditor } from './BotToolEditor'
import type { BotToolDetails } from '../../../../shared/bot-tools'

const context = {
  folder: '/isolated/bots/atlas',
  platform: 'darwin' as const,
  agent: 'codex' as const
}
const saved: BotToolDetails = {
  version: 'a'.repeat(64),
  server: {
    name: 'docs',
    url: 'https://docs.example/mcp',
    transport: 'http',
    headers: [{ key: 'Authorization', configured: true }]
  }
}
afterEach(cleanup)
const paste = (value: string) =>
  fireEvent.change(screen.getByLabelText('Server URL or start command'), { target: { value } })
const field = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
function setup(details?: BotToolDetails, taken = new Set<string>()) {
  const onSave = vi.fn(async () => {})
  const onCancel = vi.fn()
  render(
    <BotToolEditor
      context={context}
      host={null}
      saved={details}
      taken={taken}
      onSave={onSave}
      onCancel={onCancel}
    />
  )
  return { onSave, onCancel }
}

describe('canonical bot tool editor', () => {
  it('adds a paste with exact argv and extracted environment, and disables malformed paste', async () => {
    const { onSave } = setup()
    paste('TOKEN="synthetic value" node server.js "two words" ""')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: 'js',
        command: 'node',
        args: ['server.js', 'two words', ''],
        env: [{ key: 'TOKEN', value: 'synthetic value' }]
      })
    )
    paste('node "invalid')
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true)
  })
  it('requires an explicit paste decision after manual edits, and Keep clears the conflicting paste', async () => {
    const { onSave } = setup()
    paste('https://first.example/mcp')
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    field('Server name', 'manual-name')
    paste('https://second.example/mcp')
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Keep my details' }))
    expect(screen.getByLabelText<HTMLInputElement>('Server URL or start command').value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: 'manual-name',
        url: 'https://first.example/mcp',
        transport: 'http',
        headers: []
      })
    )
    paste('node "bad')
    fireEvent.click(screen.getByRole('button', { name: 'Use this paste' }))
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true)
  })
  it('explicitly replaces manual details with a valid paste and drops inactive credentials', async () => {
    const { onSave } = setup()
    paste('https://first.example/mcp')
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }))
    field('Server name', 'manual-name')
    fireEvent.click(screen.getByRole('button', { name: '+ Add header' }))
    field('header name 1', 'Authorization')
    field('header value 1', 'synthetic-old')
    paste('node worker.js "exact spaced arg"')
    field('Server name', 'latest-manual-name')
    fireEvent.click(screen.getByRole('button', { name: 'Use this paste' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: 'worker-js',
        command: 'node',
        args: ['worker.js', 'exact spaced arg'],
        env: []
      })
    )
  })

  it('initializes saved structured details, keeps blank secrets, replaces them and explicitly removes rows', async () => {
    const { onSave } = setup(saved)
    expect(screen.getByLabelText<HTMLInputElement>('header value 1').value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith({
        ...saved.server,
        headers: [{ key: 'Authorization', keep: true }]
      })
    )
    field('header value 1', 'synthetic-replacement')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith({
        ...saved.server,
        headers: [{ key: 'Authorization', value: 'synthetic-replacement' }]
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove header 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ ...saved.server, headers: [] }))
  })
  it('blocks unchanged saved credentials on a new destination, collisions, and cancel writes nothing', () => {
    const { onSave, onCancel } = setup(saved, new Set(['taken']))
    field('Server URL', 'https://other.example/mcp')
    expect(screen.getByText(/credential destination changed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true)
    field('header value 1', 'reentered')
    field('Server name', 'taken')
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Use taken-2' }))
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      false
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })
})
