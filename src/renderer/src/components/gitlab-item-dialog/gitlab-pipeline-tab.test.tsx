// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Tabs } from '@/components/ui/tabs'
import { i18n } from '@/i18n/i18n'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
import { GitLabPipelineTab } from './gitlab-pipeline-tab'
import { useGitLabItemDialogState } from './use-gitlab-item-dialog-state'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

const item: GitLabWorkItem = {
  id: 'gitlab-mr-1',
  repoId: 'repo-1',
  type: 'mr',
  number: 1,
  title: 'Invalid pipeline configuration',
  state: 'opened',
  url: 'https://gitlab.com/acme/app/-/merge_requests/1',
  labels: [],
  updatedAt: '',
  author: null
}

const details: GitLabWorkItemDetails = { item, body: '', comments: [], pipelineJobs: [] }
const failedDetails = {
  ...details,
  pipeline: {
    id: 99,
    status: 'failed',
    webUrl: 'https://gitlab.com/acme/app/-/pipelines/99'
  }
}

function PipelineTab({ data = failedDetails }: { data?: GitLabWorkItemDetails }) {
  const state = useGitLabItemDialogState(item.id)
  return (
    <Tabs value="pipeline">
      <GitLabPipelineTab
        item={item}
        state={{ ...state, details: data }}
        pipelineActions={{ handleRetryJob: vi.fn(), handleToggleJobTrace: vi.fn() }}
      />
    </Tabs>
  )
}

it.each([
  ['en', 'Failed'],
  ['es', 'Falló']
])('shows the failed zero-job head pipeline in %s', async (language, failedLabel) => {
  await i18n.changeLanguage(language)
  render(<PipelineTab />)

  expect(screen.queryByText('No pipeline runs for this MR.')).toBeNull()
  expect(screen.getByText(failedLabel)).toBeTruthy()
  expect(screen.getByRole('link', { name: /Pipeline #99/ }).getAttribute('href')).toBe(
    failedDetails.pipeline.webUrl
  )
})

it('keeps the no-pipeline message when the MR has no head pipeline', () => {
  render(<PipelineTab data={{ item, body: '', comments: [] }} />)

  expect(screen.getByText('No pipeline runs for this MR.')).toBeTruthy()
  expect(screen.queryByRole('link', { name: /Pipeline/ })).toBeNull()
})

it('keeps child jobs visible below the pipeline summary', () => {
  render(
    <PipelineTab
      data={{
        ...failedDetails,
        pipelineJobs: [
          {
            id: 101,
            name: 'build',
            stage: 'test',
            status: 'failed',
            webUrl: 'https://gitlab.com/acme/app/-/jobs/101',
            duration: 1
          }
        ]
      }}
    />
  )

  expect(screen.getByText('Pipeline #99')).toBeTruthy()
  expect(screen.getByText('build')).toBeTruthy()
})
