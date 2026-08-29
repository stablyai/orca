import type { TaskProvider } from '../../../shared/task-providers'

export function getTaskProviderDisplayName(provider: TaskProvider): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
    case 'paperclip':
      return 'Paperclip'
  }
}
